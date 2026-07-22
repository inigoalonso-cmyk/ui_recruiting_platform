const state = {
  section: 'screening', // 'screening', 'recruiters', 'jobinfo', 'companyfaq', or 'settings'
  jobs: [],
  selected: 'general', // 'general' or job.id
  view: 'criteria',    // 'criteria' or 'history'
  historyApp: null,    // selected application id in the history detail view
  recruiterJobs: [],
  recruiterSelected: null, // recruiter_job id, or null when nothing is selected
  settings: null,      // cached app settings (pass threshold, etc.)
  renamingFolderId: null, // job folder currently in inline-rename mode
  collapsedFolders: new Set(), // role folder ids whose variant subfolders are collapsed in the sidebar
  renamingRecruiterFolderId: null, // recruiter folder in inline-rename mode
  jobInfoSelected: 'general', // 'general' or job.id in the Job Info section
  renamingJobInfoFolderId: null, // job folder being renamed from Job Info
  editingFactId: null, // job-info fact currently being edited inline
  expandedFacts: new Set(), // fact ids currently expanded (client-side only)
  historyView: 'timeline', // 'timeline' or 'analytics' sub-view of History
  analyticsJob: '', // '' = all jobs, else a job id, for the analytics funnel
  jobInfoView: 'facts', // 'facts' or 'suggestions' sub-view of Job Info
  openSuggestionKey: null, // normalized text of the suggestion whose add form is open
  testingJobId: null, // job id whose full-screen Testing (sandbox) view is open, else null
};

// Pass/fail cutoff, read from settings (falls back to 8 until loaded).
function passThreshold() {
  const t = state.settings && Number(state.settings.pass_threshold);
  return Number.isFinite(t) ? t : 8;
}

const contentEl = document.getElementById('content');
const folderListEl = document.getElementById('folder-list');
const recruiterFolderListEl = document.getElementById('recruiter-folder-list');
const jobinfoFolderListEl = document.getElementById('jobinfo-folder-list');
const toastEl = document.getElementById('toast');

// ---- Folder filter: live-hide non-matching rows in a folder list ----
function wireFolderFilter(inputId, listEl) {
  const input = document.getElementById(inputId);
  if (!input || !listEl) return;
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    listEl.querySelectorAll('.folder-row').forEach(row => {
      row.style.display = (!q || row.textContent.toLowerCase().includes(q)) ? '' : 'none';
    });
    listEl.querySelectorAll('.folder-divider').forEach(d => { d.style.display = q ? 'none' : ''; });
  });
}
wireFolderFilter('folder-filter', folderListEl);
wireFolderFilter('recruiter-folder-filter', recruiterFolderListEl);
wireFolderFilter('jobinfo-folder-filter', jobinfoFolderListEl);

// ---- Theme toggle (persisted; initial theme applied in <head>) ----
document.getElementById('theme-toggle').addEventListener('click', () => {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (dark) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', 'dark');
  try { localStorage.setItem('hr-theme', dark ? 'light' : 'dark'); } catch (e) {}
});

// ---- Keyboard: "/" or ⌘/Ctrl+K focuses the visible folder filter ----
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
  const slash = e.key === '/' && !typing;
  const cmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
  if (slash || cmdK) {
    const visible = ['folder-filter', 'jobinfo-folder-filter', 'recruiter-folder-filter']
      .map(id => document.getElementById(id))
      .find(el => el && el.offsetParent !== null);
    if (visible) { e.preventDefault(); visible.focus(); visible.select(); }
  }
});

function showToast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { toastEl.className = 'toast'; }, 2600);
}

// Copy text to the clipboard, with a fallback for non-secure contexts.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the textarea fallback */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
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
  renderJobInfoFolderList(); // same jobs power the Job Info folder list
}

function renderFolderList() {
  folderListEl.innerHTML = '';
  // "General" is a virtual folder (its params are stored with job_id IS NULL,
  // and it's not a row in the jobs table) — so it can't be renamed or removed.
  folderListEl.appendChild(buildFolderRow({ id: 'general', name: 'General', general: true }));
  // Top-level "role" folders first (Production > Development > Edit within group),
  // each immediately followed by its variant subfolders (same ordering, indented).
  const byMode = (a, b) => modeRank(a) - modeRank(b);
  state.jobs
    .filter(j => !j.parent_id)
    .sort(byMode)
    .forEach(job => {
      const children = state.jobs.filter(j => j.parent_id === job.id).sort(byMode);
      const collapsed = state.collapsedFolders.has(job.id);
      folderListEl.appendChild(buildFolderRow(job, { hasChildren: children.length > 0, collapsed }));
      if (children.length && !collapsed) {
        children.forEach(child => folderListEl.appendChild(buildFolderRow(child, { child: true })));
      }
    });
}

// Collapse/expand a role folder's variant subfolders in the sidebar.
function toggleCollapse(jobId) {
  if (state.collapsedFolders.has(jobId)) state.collapsedFolders.delete(jobId);
  else state.collapsedFolders.add(jobId);
  renderFolderList();
}

function buildFolderRow(job, opts = {}) {
  const row = document.createElement('div');
  row.className = 'folder-row' + (opts.child ? ' folder-child' : '') + (state.selected === job.id ? ' active' : '');

  // Inline rename mode for a real folder.
  if (!job.general && state.renamingFolderId === job.id) {
    const input = document.createElement('input');
    input.className = 'folder-rename-input';
    input.value = job.name;
    row.appendChild(input);
    wireFolderRename(input, job);
    return row;
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'folder-tab' + (job.general ? ' general' : '') + (state.selected === job.id ? ' active' : '');
  btn.innerHTML = `${folderDotHtml(job)}<span class="folder-tab-name">${escapeHtml(job.name)}</span>`;
  btn.onclick = () => selectFolder(job.id);
  // Collapse/expand toggle for role folders that have variant subfolders.
  if (opts.hasChildren) {
    const tog = document.createElement('button');
    tog.type = 'button';
    tog.className = 'folder-collapse';
    tog.textContent = opts.collapsed ? '▸' : '▾';
    tog.title = opts.collapsed ? 'Expand variants' : 'Collapse variants';
    tog.onclick = (e) => { e.stopPropagation(); toggleCollapse(job.id); };
    row.appendChild(tog);
  }
  row.appendChild(btn);

  if (!job.general) {
    const items = [
      { label: 'Rename', onSelect: () => { state.renamingFolderId = job.id; renderFolderList(); } },
    ];
    // Only top-level role folders can hold variants (one level of nesting).
    if (!opts.child) items.push({ label: 'Add variant', onSelect: () => window.AshbyLink && window.AshbyLink.createSubfolder(job) });
    items.push({ label: 'Remove', variant: 'danger', onSelect: () => confirmRemoveFolder(job) });
    row.appendChild(RowMenu.createRowMenu(items));
  }
  return row;
}

// Turns the folder title into an inline text field; saves on Enter/blur,
// cancels on Escape.
function wireFolderRename(input, job) {
  let settled = false;
  requestAnimationFrame(() => { input.focus(); input.select(); });

  async function save() {
    if (settled) return;
    settled = true;
    const name = input.value.trim();
    state.renamingFolderId = null;
    if (!name || name === job.name) { renderFolderList(); return; }
    try {
      await api(`/jobs/${job.id}`, { method: 'PUT', body: JSON.stringify({ name }) });
      await loadJobs(); // refreshes state.jobs + re-renders the list
      if (state.selected === job.id) await renderContent(); // update the header
      showToast('Folder renamed');
    } catch (err) {
      showToast(err.message, true);
      renderFolderList();
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { settled = true; state.renamingFolderId = null; renderFolderList(); }
  });
  input.addEventListener('blur', save);
}

async function confirmRemoveFolder(job) {
  // A job folder is one shared identity across Screening, Recruiters and Job
  // Info, so deleting it removes everything in it. Fetch counts for the message.
  let pCount = 0, kCount = 0, fCount = 0;
  try {
    const [params, killers, facts] = await Promise.all([
      api(`/jobs/${job.id}/parameters`),
      api(`/jobs/${job.id}/killer-questions`),
      api(`/jobs/${job.id}/job-info`),
    ]);
    pCount = params.length;
    kCount = killers.length;
    fCount = facts.length;
  } catch { /* fall back to 0s in the message */ }

  RowMenu.confirmDialog({
    title: 'Delete folder',
    message: `Delete "${job.name}"? This removes the job folder and all ${plural(pCount, 'parameter')}, ${plural(kCount, 'killer question')}, and ${plural(fCount, 'job-info fact')} in it. This can't be undone.`,
    confirmLabel: 'Delete',
    onConfirm: async () => {
      await api(`/jobs/${job.id}`, { method: 'DELETE' });
      await loadJobs(); // re-renders both the Screening and Job Info folder lists
      // Fall back to General in whichever section had this folder selected.
      if (state.selected === job.id) state.selected = 'general';
      if (state.jobInfoSelected === job.id) state.jobInfoSelected = 'general';
      renderFolderList();
      renderJobInfoFolderList();
      await renderContent();
      showToast('Folder deleted');
    },
  });
}

// Escapes &, <, >, and BOTH quote characters. The quotes matter because the
// result is interpolated into double-quoted HTML attributes (value="...",
// data-*="..."); a stray " in a folder/param/fact name would otherwise break
// out of the attribute. (textContent→innerHTML only escapes &, <, > — not quotes.)
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Initials for the little circular avatars (e.g. "Jorge Janeiro" -> "JJ").
function initials(name) {
  const s = (name || '').trim();
  if (!s) return '—';
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// "1 parameter" / "3 parameters" — pluralize a count + word.
function plural(n, w) {
  return `${n} ${w}${n === 1 ? '' : 's'}`;
}

async function selectFolder(id) {
  state.selected = id;
  state.view = 'criteria';
  state.historyApp = null;
  state.testingJobId = null; // selecting a folder always lands on its criteria view
  document.getElementById('nav-criteria').classList.add('active');
  document.getElementById('nav-history').classList.remove('active');
  document.getElementById('criteria-nav').style.display = '';
  renderFolderList();
  await renderContent();
}

function setView(view) {
  state.view = view;
  state.testingJobId = null; // Criteria/History nav leaves the Testing screen
  document.getElementById('nav-criteria').classList.toggle('active', view === 'criteria');
  document.getElementById('nav-history').classList.toggle('active', view === 'history');
  document.getElementById('criteria-nav').style.display = view === 'criteria' ? '' : 'none';
  renderContent();
}

// Serialize renders: renderContent() is fired (often without await) from many
// handlers, and each render sets contentEl.innerHTML then awaits fetches before
// filling sub-sections — so overlapping renders could let a slow earlier fetch
// overwrite newer content. This wrapper runs one render at a time and, if more
// calls arrive mid-render, coalesces them into a single final re-render with the
// latest state, so the last request always wins.
let _rendering = false;
let _renderQueued = false;
async function renderContent() {
  if (_rendering) { _renderQueued = true; return; }
  _rendering = true;
  try {
    do {
      _renderQueued = false;
      await renderContentOnce();
    } while (_renderQueued);
  } finally {
    _rendering = false;
  }
}

async function renderContentOnce() {
  if (state.section === 'recruiters') {
    await renderRecruitersView();
    return;
  }
  if (state.section === 'jobinfo') {
    if (state.jobInfoView === 'suggestions') {
      await renderSuggestionsView();
    } else {
      await renderJobInfoView();
    }
    return;
  }
  if (state.section === 'companyfaq') {
    await renderCompanyFaqView();
    return;
  }
  if (state.view === 'history') {
    if (state.historyApp) {
      await renderHistoryDetail(state.historyApp);
    } else if (state.historyView === 'analytics') {
      await renderAnalytics();
    } else {
      await renderHistoryList();
    }
    return;
  }
  if (state.selected === 'general') {
    await renderGeneralView();
  } else if (state.testingJobId && state.testingJobId === state.selected) {
    await renderTestingView(state.selected);
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
  const mode = job.mode || 'normal';
  // A folder with variant subfolders is a "role" template: it stays in Edit and
  // its Ashby jobs are linked on the variants, not here.
  const hasChildren = state.jobs.some(j => j.parent_id === job.id);

  contentEl.innerHTML = `
    <div class="folder-header">
      <div class="folder-header-main">
        <div class="folder-label">${hasChildren ? 'Role folder' : (job.parent_id ? 'Variant folder' : 'Job folder')}</div>
        <h1 class="folder-title">${escapeHtml(job.name)}</h1>
      </div>
      <div class="folder-toolbar">
        ${hasChildren
          ? '<span class="mode-static" title="Role folders stay in Edit; set their variants to Development/Production">⚪ Edit · role</span>'
          : modeDropdownHtml(mode)}
        ${(!hasChildren && mode === 'development') ? '<button type="button" class="btn-secondary testing-btn" id="open-testing" title="Open the testing sandbox">🧪 Testing</button>' : ''}
      </div>
    </div>
    ${hasChildren ? '' : modeBannerHtml(mode)}
    <div class="section" id="ashby-link-section">
      <div class="section-heading"><h2>Ashby jobs</h2></div>
      ${hasChildren
        ? '<div class="section-hint">Role folder — link Ashby jobs on its variants, not here.</div>'
        : '<div id="ashby-link-mount"></div>'}
    </div>
    <div class="section" id="params-section"></div>
    <div class="section" id="killer-section"></div>
  `;

  if (!hasChildren) wireModeDropdown(contentEl, jobId);
  // The Testing sandbox is only reachable while the folder is in Development.
  const openTestingBtn = document.getElementById('open-testing');
  if (openTestingBtn) openTestingBtn.addEventListener('click', () => openTesting(jobId));

  // Ashby job linking picker (Model B) — only on leaf folders (roles link via variants).
  if (!hasChildren && window.AshbyLink) window.AshbyLink.renderPicker(document.getElementById('ashby-link-mount'), job);

  const [params, killers] = await Promise.all([
    api(`/jobs/${jobId}/parameters`),
    api(`/jobs/${jobId}/killer-questions`),
  ]);

  renderParamsSection(document.getElementById('params-section'), params, jobId);
  renderKillerSection(document.getElementById('killer-section'), killers, jobId);

  // Criteria + killer questions are only editable in Normal mode. In
  // Development / Production the two sections render locked (disabled inputs,
  // add/remove hidden, dimmed) so a live or under-test folder can't be changed.
  if (mode !== 'normal') {
    lockSection(document.getElementById('params-section'));
    lockSection(document.getElementById('killer-section'));
  }
}

// ---- Folder lifecycle mode: dropdown picker + banner + section lock ----

const MODE_META = {
  // Internal value stays 'normal' (backend/DB/lock logic unchanged); only the
  // user-facing label is "Edit" — that's the mode where criteria are editable.
  normal:      { icon: '⚪', label: 'Edit' },
  development: { icon: '🟠', label: 'Development' },
  production:  { icon: '🟢', label: 'Production' },
};

// Sidebar sort order: Production folders float to the top, then Development,
// then Edit (normal). Unknown/missing mode sorts as Edit.
const MODE_RANK = { production: 0, development: 1, normal: 2 };
function modeRank(job) {
  return MODE_RANK[job.mode || 'normal'] ?? 2;
}
// The little colored dot shown before a folder name in the sidebar lists.
function folderDotHtml(job) {
  if (!job || job.general || job.companyfaq) return ''; // virtual folders have no mode
  return `<span class="folder-dot mode-${job.mode || 'normal'}" aria-hidden="true"></span>`;
}

// Per-state app configuration: what each folder lifecycle state enables in the
// UI. Test screenings ("Run screening") are only allowed in Development —
// disabled in Production (live) and Normal (parked). Extend with more per-mode
// flags as needed.
const MODE_CONFIG = {
  normal:      { canRunScreening: false },
  development: { canRunScreening: true },
  production:  { canRunScreening: false },
};
function modeConfig(mode) {
  return MODE_CONFIG[mode] || MODE_CONFIG.normal;
}

// Compact mode picker: a styled native <select> wrapped so the current mode's
// colour dot is visible. Selecting an option calls switchMode() (wired
// separately so the same markup can be reused on the folder + Testing views).
function modeDropdownHtml(mode) {
  const opt = (m) => `<option value="${m}"${m === mode ? ' selected' : ''}>${MODE_META[m].icon} ${MODE_META[m].label}</option>`;
  return `
    <div class="mode-select-wrap mode-${mode}" title="Folder lifecycle mode">
      <span class="mode-dot" aria-hidden="true"></span>
      <select class="mode-select" aria-label="Folder lifecycle mode">
        ${opt('normal')}${opt('development')}${opt('production')}
      </select>
    </div>`;
}

// Wire every mode <select> inside a container to switchMode for the given job.
function wireModeDropdown(container, jobId) {
  container.querySelectorAll('.mode-select').forEach((sel) => {
    sel.addEventListener('change', () => switchMode(jobId, sel.value));
  });
}

// ---- Full-screen Testing (sandbox) view navigation ----
function openTesting(jobId) {
  state.testingJobId = jobId;
  renderContent();
}
function closeTesting() {
  state.testingJobId = null;
  renderContent();
}

function modeBannerHtml(mode) {
  const text = {
    normal: '⚪ Editing mode — changes are saved but this folder is not being scored. Set it to Development to test, or Production to go live.',
    development: '🟠 Testing mode — configuration is locked. Switch to Edit to change criteria.',
    production: '🟢 Live — this folder is scored automatically every 5 minutes. Switch to Edit to change it.',
  }[mode] || '';
  return `<div class="mode-banner mode-${mode}">${escapeHtml(text)}</div>`;
}

async function switchMode(jobId, mode) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job || (job.mode || 'normal') === mode) return;
  try {
    await api(`/jobs/${jobId}/mode`, { method: 'PUT', body: JSON.stringify({ mode }) });
    await loadJobs();
    // The Testing sandbox only applies in Development. If we switch this folder
    // away from Development while on its Testing screen, close it and drop back
    // to the criteria/parameters view instead of sitting on a locked sandbox.
    if (mode !== 'development' && state.testingJobId === jobId) {
      state.testingJobId = null;
    }
    await renderContent();
    showToast(`Mode set to ${(MODE_META[mode] || {}).label || mode}`);
  } catch (err) {
    showToast(err.message, true);
    renderContent(); // revert the mode dropdown to the folder's real mode on failure
  }
}

// Make a rendered section read-only: disable every control and hide the
// add/remove affordances, then dim it via the .locked class. Does not touch the
// shared render functions, so General and other callers are unaffected.
function lockSection(container) {
  if (!container) return;
  container.classList.add('locked');
  container.querySelectorAll('input, select, textarea, button').forEach(el => { el.disabled = true; });
  container.querySelectorAll('.add-row-form, .add-killer-form, .add-fact-form, .row-delete').forEach(el => { el.style.display = 'none'; });
}

// ---- Development sandbox: upload a CV, run scoring, poll + list results ----

// Compact relative timestamp for dev-run cards (SQLite UTC "YYYY-MM-DD HH:MM:SS").
function fmtRelative(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return String(iso);
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days}d ago`;
  return fmtDate(iso);
}

// Full-screen Testing view for a single folder: mode picker + a read-only
// "Testing against" summary + the sandbox (upload / run / results). The sandbox
// only runs when the folder is in Development; past results always show.
async function renderTestingView(jobId) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) { state.testingJobId = null; return renderContent(); }
  const mode = job.mode || 'normal';
  // "Run screening" is gated by the per-state config: only Development can run
  // test screenings; Production (live) and Normal (parked) disable the component.
  const canRun = modeConfig(mode).canRunScreening;

  contentEl.innerHTML = `
    <button class="back-link" id="testing-back">← Back to criteria</button>
    <div class="folder-header">
      <div class="folder-header-main">
        <div class="folder-label">Testing</div>
        <h1 class="folder-title">🧪 Testing — ${escapeHtml(job.name)}</h1>
      </div>
      <div class="folder-toolbar">
        ${modeDropdownHtml(mode)}
      </div>
    </div>
    ${canRun
      ? ''
      : `<div class="mode-banner mode-development testing-prompt">🟠 Set this folder to <strong>Development</strong> to run test screenings. Past results are still shown below.</div>`}
    <div class="section" id="testing-summary"></div>
    <div class="section" id="dev-section"></div>
  `;

  document.getElementById('testing-back').addEventListener('click', closeTesting);
  wireModeDropdown(contentEl, jobId);

  await renderTestingSummary(document.getElementById('testing-summary'), jobId);
  await renderDevSection(document.getElementById('dev-section'), jobId, { disabled: !canRun });
}

// Compact, read-only panel showing what a test CV is scored against: the job's
// evaluation parameters (with weights), the always-applied General parameters,
// and the killer questions.
async function renderTestingSummary(container, jobId) {
  if (!container) return;
  container.innerHTML = `
    <div class="section-heading"><h2>Testing against</h2></div>
    <div class="card testing-against"><div class="empty-state">Loading…</div></div>`;
  const cardEl = container.querySelector('.testing-against');

  const job = state.jobs.find(j => j.id === jobId) || {};
  let params = [], general = [], killers = [], parentParams = [];
  try {
    [params, general, killers, parentParams] = await Promise.all([
      api(`/jobs/${jobId}/parameters`),
      api('/jobs/general/parameters').catch(() => []),
      api(`/jobs/${jobId}/killer-questions`),
      job.parent_id ? api(`/jobs/${job.parent_id}/parameters`).catch(() => []) : Promise.resolve([]),
    ]);
  } catch (err) {
    cardEl.innerHTML = `<div class="empty-state">Could not load criteria: ${escapeHtml(err.message)}</div>`;
    return;
  }

  const chip = (p) => `<span class="ta-chip">${escapeHtml(p.name)}<span class="ta-weight">${escapeHtml(String(p.weight))}</span></span>`;
  const group = (label, inner) => `
    <div class="ta-group">
      <div class="ta-group-label">${escapeHtml(label)}</div>
      ${inner}
    </div>`;

  const paramsHtml = params.length
    ? `<div class="ta-chips">${params.map(chip).join('')}</div>`
    : `<div class="ta-empty">No job-specific parameters.</div>`;

  const generalHtml = general.length
    ? group('General parameters (all jobs)', `<div class="ta-chips">${general.map(chip).join('')}</div>`)
    : '';

  // Variant folders inherit their parent role's parameters too.
  const parentHtml = parentParams.length
    ? group('Inherited from role folder', `<div class="ta-chips">${parentParams.map(chip).join('')}</div>`)
    : '';

  const killersHtml = killers.length
    ? `<div class="ta-killers">${killers.map(k => {
        const pass = k.expected_answer === undefined || k.expected_answer === null ? true : !!k.expected_answer;
        return `<div class="ta-killer">
          <span class="ta-killer-q">${escapeHtml(k.question)}</span>
          <span class="pill ${pass ? 'pass' : 'fail'}">expects ${pass ? 'True' : 'False'}</span>
        </div>`;
      }).join('')}</div>`
    : `<div class="ta-empty">No killer questions.</div>`;

  cardEl.innerHTML =
    group('Evaluation parameters', paramsHtml)
    + parentHtml
    + generalHtml
    + group('Killer questions', killersHtml);
}

async function renderDevSection(container, jobId, opts = {}) {
  if (!container) return;
  const disabled = !!opts.disabled;
  container.innerHTML = `
    <div class="section-heading"><h2>Run a test screening</h2></div>
    <div class="section-hint">Upload a test CV and run the exact same scoring as production — plus a reason for each parameter.</div>
    <div class="card dev-run-card">
      <div class="dev-drop" id="dev-drop">
        <input type="file" id="dev-file" accept=".pdf,.docx,.txt" hidden />
        <div class="dev-drop-inner">
          <span class="dev-drop-title">Drag &amp; drop a CV here, or <button type="button" class="dev-browse" id="dev-browse">browse</button></span>
          <span class="dev-drop-file" id="dev-file-name">PDF, DOCX or TXT</span>
        </div>
      </div>
      <div class="dev-run-row">
        <input type="text" id="dev-candidate" class="dev-candidate-input" placeholder="Candidate name (optional)" autocomplete="off" />
        <button type="button" class="btn-primary" id="dev-run-btn"${disabled ? ' disabled title="Set this folder to Development to run screenings"' : ''}>Run screening</button>
      </div>
    </div>
    <div class="section-heading dev-results-heading"><h2>Recent runs</h2></div>
    <div class="dev-results" id="dev-results"><div class="empty-state">Loading runs…</div></div>
  `;

  let selectedFile = null;
  const drop = container.querySelector('#dev-drop');
  const fileInput = container.querySelector('#dev-file');
  const fileName = container.querySelector('#dev-file-name');
  const runBtn = container.querySelector('#dev-run-btn');

  const setFile = (file) => {
    selectedFile = file || null;
    fileName.textContent = selectedFile ? selectedFile.name : 'PDF, DOCX or TXT';
  };

  container.querySelector('#dev-browse').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => setFile(fileInput.files[0]));
  drop.addEventListener('click', (e) => { if (e.target === drop || e.target.classList.contains('dev-drop-inner') || e.target.classList.contains('dev-drop-title') || e.target.classList.contains('dev-drop-file')) fileInput.click(); });
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragover'); }));
  ['dragleave', 'dragend'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('dragover')));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) { setFile(e.dataTransfer.files[0]); }
  });

  runBtn.addEventListener('click', () => runDevScreening(jobId, selectedFile, container.querySelector('#dev-candidate').value.trim(), runBtn));

  await loadDevResults(jobId);
}

async function runDevScreening(jobId, file, candidateName, runBtn) {
  if (!file) { showToast('Choose a CV file first', true); return; }
  runBtn.disabled = true;
  const original = runBtn.textContent;
  runBtn.textContent = 'Running…';
  try {
    const fd = new FormData();
    fd.append('cv', file);
    if (candidateName) fd.append('candidate_name', candidateName);
    // Deliberately NOT using api(): it forces a JSON content-type. Let the
    // browser set the multipart boundary itself.
    const res = await fetch(`/api/jobs/${jobId}/dev/run`, { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    const run = data.run || data;
    if (!res.ok) {
      // e.g. 501 with { error, run }: the run row was created but the workflow
      // trigger isn't wired up yet. Surface the message, still show the row.
      showToast(data.error || `Error ${res.status}`, true);
    } else {
      showToast('Screening started');
    }
    await loadDevResults(jobId);
    if (run && run.id && (run.status === 'pending' || !run.status)) pollDevRun(jobId, run.id);
  } catch (err) {
    showToast(err.message || 'Run failed', true);
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = original;
  }
}

async function loadDevResults(jobId) {
  const listEl = document.getElementById('dev-results');
  if (!listEl) return;
  let runs;
  try {
    runs = await api(`/jobs/${jobId}/dev/results`);
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state">Could not load runs: ${escapeHtml(err.message)}</div>`;
    return;
  }
  if (!Array.isArray(runs) || !runs.length) {
    listEl.innerHTML = `<div class="empty-state">No test runs yet. Upload a CV above to score it.</div>`;
    return;
  }
  listEl.innerHTML = '';
  runs.forEach(run => listEl.appendChild(buildDevRunCard(run, jobId)));
}

// Render the scoring agent's markdown breakdown safely: escape first, then turn
// leading -/*/• into bullets and **bold** into <strong> (operating on already-
// escaped text, so it can't inject markup).
function renderBreakdownMd(text) {
  return String(text).split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t) return '';
    const bullet = /^[-*•]\s+/.test(t);
    const safe = escapeHtml(t.replace(/^[-*•]\s+/, '')).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    return `<div class="dev-param-line${bullet ? ' bullet' : ''}">${safe}</div>`;
  }).join('');
}

function buildDevRunCard(run, jobId) {
  const el = document.createElement('div');
  el.className = 'dev-run';
  const status = run.status || 'pending';
  const name = run.candidate_name || 'Unnamed candidate';

  let rightHtml = '';
  if (status === 'pending') {
    rightHtml = `<div class="dev-scoring"><span class="dev-spinner" aria-hidden="true"></span>Scoring…</div>`;
  } else if (status === 'done') {
    const score = run.score == null ? '—' : `${run.score}/10`;
    let pill = '';
    let scoreCls = '';
    if (run.passed === true) { pill = `<span class="pill pass">Pass</span>`; scoreCls = ' pass'; }
    else if (run.passed === false) { pill = `<span class="pill fail">Fail vs threshold ${escapeHtml(String(run.pass_threshold))}</span>`; scoreCls = ' fail'; }
    rightHtml = `<div class="dev-score-wrap"><span class="dev-score${scoreCls}">${escapeHtml(String(score))}</span>${pill}</div>`;
  }

  el.innerHTML = `
    <div class="dev-run-head">
      <div class="dev-run-id">
        <div class="dev-run-name">${escapeHtml(name)}</div>
        <div class="dev-run-sub"><span class="mono">${escapeHtml(run.cv_filename || '—')}</span> · ${escapeHtml(fmtRelative(run.created_at))}</div>
      </div>
      <div class="dev-run-right">
        ${rightHtml}
        <button type="button" class="row-delete dev-run-delete" title="Delete run">×</button>
      </div>
    </div>
    <div class="dev-run-body"></div>
  `;

  const body = el.querySelector('.dev-run-body');
  if (status === 'error') {
    body.innerHTML = `<div class="dev-error">${escapeHtml(run.error || 'Scoring failed')}</div>`;
  } else if (status === 'done') {
    let html = '';
    if (run.rationale) html += `<p class="dev-rationale">${escapeHtml(run.rationale)}</p>`;
    // The scoring agent emits the per-parameter "why" as a markdown string
    // (parameter_breakdown). Older/array form (parameter_reasoning) still renders.
    const breakdown = run.parameter_breakdown;
    const reasoning = Array.isArray(run.parameter_reasoning) ? run.parameter_reasoning : [];
    if (typeof breakdown === 'string' && breakdown.trim()) {
      html += `<div class="dev-param-title">Why each parameter</div><div class="dev-param-md">${renderBreakdownMd(breakdown)}</div>`;
    } else if (reasoning.length) {
      html += `<div class="dev-param-title">Why each parameter</div><div class="dev-param-list">`;
      reasoning.forEach(p => {
        const hasImp = p && p.importance != null && p.importance !== '';
        const imp = hasImp ? `<span class="dev-imp-chip">${escapeHtml(String(p.importance))}</span>` : '';
        html += `
          <div class="dev-param-row">
            <div class="dev-param-head"><span class="dev-param-name">${escapeHtml((p && p.parameter) || '—')}</span>${imp}</div>
            ${p && p.note ? `<div class="dev-param-note">${escapeHtml(p.note)}</div>` : ''}
          </div>`;
      });
      html += `</div>`;
    }
    body.innerHTML = html;
  } else {
    body.style.display = 'none';
  }

  el.querySelector('.dev-run-delete').addEventListener('click', async () => {
    try {
      await api(`/jobs/${jobId}/dev/results/${run.id}`, { method: 'DELETE' });
      showToast('Run deleted');
      await loadDevResults(jobId);
    } catch (err) { showToast(err.message, true); }
  });

  return el;
}

// Poll a single run until it leaves 'pending' (~2s cadence, give up after ~60s).
// Stops itself if the user navigates away from this folder's dev sandbox.
function pollDevRun(jobId, runId) {
  const start = Date.now();
  const interval = setInterval(async () => {
    const stillHere = state.section === 'screening' && state.view === 'criteria'
      && state.testingJobId === jobId && document.getElementById('dev-results');
    if (!stillHere || Date.now() - start > 60000) { clearInterval(interval); return; }
    try {
      const run = await api(`/jobs/${jobId}/dev/results/${runId}`);
      if (run && run.status && run.status !== 'pending') {
        clearInterval(interval);
        await loadDevResults(jobId);
      }
    } catch { /* transient error — keep polling until the timeout */ }
  }, 2000);
}

// Weights are relative importance, not a fixed /10 total. Recompute each row's
// share of the current total live, so recruiters never have to hit an exact sum.
function recomputeWeightNormalization(cardEl) {
  if (!cardEl) return;
  const rows = [...cardEl.querySelectorAll('.param-row')];
  const vals = rows.map(r => Math.max(0, Number(r.querySelector('.weight-input').value) || 0));
  const total = vals.reduce((sum, v) => sum + v, 0);
  rows.forEach((r, i) => {
    const pct = total > 0 ? (vals[i] / total) * 100 : 0;
    const fill = r.querySelector('.weight-bar-fill');
    const label = r.querySelector('.weight-pct');
    if (fill) fill.style.width = `${pct}%`;
    if (label) label.textContent = total > 0 ? `${pct.toFixed(0)}%` : '—';
  });
}

function renderParamsSection(container, params, scopeId) {
  container.innerHTML = `
    <div class="section-heading">
      <h2>Evaluation parameters</h2>
      <span class="weight-total">relative weights · auto-normalized</span>
    </div>
    <div class="card">
      <div id="param-rows"></div>
      <form class="add-row-form" id="add-param-form">
        <input type="text" name="name" placeholder="Parameter name (e.g. years of experience)" required />
        <input type="number" name="weight" class="weight-field" min="0" step="any" placeholder="importance" required />
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
    recomputeWeightNormalization(container.querySelector('.card'));
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
      <div class="weight-bar"><div class="weight-bar-fill" style="width:0%"></div></div>
      <input class="weight-input" type="number" min="0" step="any" value="${p.weight}" />
      <span class="weight-pct" title="Share of the total weight">—</span>
    </div>
    <input class="added-by" value="${escapeHtml(p.added_by || '')}" placeholder="added by" />
    <button class="row-delete" title="Delete">×</button>
  `;

  const nameInput = row.querySelector('.param-name');
  const weightInput = row.querySelector('.weight-input');
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
    recomputeWeightNormalization(row.closest('.card'));
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

// Compact "Expects: True / False" select — the answer that counts as a pass.
function expectsSelect(expected) {
  const isTrue = expected === undefined || expected === null ? true : !!expected;
  return `
    <label class="expects-control" title="The answer that counts as a pass for this question">
      <span class="expects-label">Expects</span>
      <select class="expects-select" name="expected_answer">
        <option value="1"${isTrue ? ' selected' : ''}>True</option>
        <option value="0"${!isTrue ? ' selected' : ''}>False</option>
      </select>
    </label>`;
}

function renderKillerSection(container, killers, jobId) {
  container.innerHTML = `
    <div class="section-heading">
      <h2>Killer questions</h2>
    </div>
    <div class="killer-list" id="killer-list"></div>
    <form class="add-killer-form" id="add-killer-form">
      <textarea name="question" placeholder="Write the killer question…" required></textarea>
      <input type="text" name="added_by" placeholder="added by" />
      ${expectsSelect(true)}
      <button type="submit" title="Add">+</button>
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
        <div class="avatar">${escapeHtml(initials(k.added_by || 'anonymous'))}</div>
        <div class="killer-body">
          <div class="killer-text">${escapeHtml(k.question)}</div>
          <div class="killer-meta">added by ${escapeHtml(k.added_by || 'anonymous')}</div>
        </div>
        ${expectsSelect(k.expected_answer)}
        <button class="row-delete" title="Delete">×</button>
      `;
      card.querySelector('.expects-select').addEventListener('change', async (e) => {
        try {
          await api(`/killer-questions/${k.id}`, { method: 'PUT', body: JSON.stringify({ expected_answer: Number(e.target.value) }) });
          showToast('Expected answer updated');
        } catch (err) { showToast(err.message, true); }
      });
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
    const expected_answer = Number(form.expected_answer.value);
    if (!question) return;
    try {
      await api(`/jobs/${jobId}/killer-questions`, { method: 'POST', body: JSON.stringify({ question, added_by, expected_answer }) });
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
  state.testingJobId = null; // leaving/among sections closes the Testing screen
  document.getElementById('section-screening').classList.toggle('active', section === 'screening');
  document.getElementById('section-recruiters').classList.toggle('active', section === 'recruiters');
  document.getElementById('section-jobinfo').classList.toggle('active', section === 'jobinfo');
  document.getElementById('nav-settings').classList.remove('active');
  document.getElementById('screening-section').style.display = section === 'screening' ? '' : 'none';
  document.getElementById('recruiters-section').style.display = section === 'recruiters' ? '' : 'none';
  document.getElementById('jobinfo-section').style.display = section === 'jobinfo' ? '' : 'none';
  renderContent();
}

document.getElementById('section-screening').addEventListener('click', () => setSection('screening'));
document.getElementById('section-recruiters').addEventListener('click', async () => {
  await loadRecruiterJobs();
  setSection('recruiters');
});
document.getElementById('section-jobinfo').addEventListener('click', () => {
  applyJobInfoNav();
  refreshSuggestionsBadge();
  setSection('jobinfo');
});
document.getElementById('nav-settings').addEventListener('click', () => setSettingsView());

// ---- Job Info sub-nav: Facts / Suggested additions ----
function applyJobInfoNav() {
  document.getElementById('nav-jobinfo-facts').classList.toggle('active', state.jobInfoView === 'facts');
  document.getElementById('nav-jobinfo-suggestions').classList.toggle('active', state.jobInfoView === 'suggestions');
  // The folder list only applies to Facts; hide it on the Suggested additions view.
  document.getElementById('jobinfo-facts-nav').style.display = state.jobInfoView === 'facts' ? '' : 'none';
}

function setJobInfoView(view) {
  state.jobInfoView = view;
  state.openSuggestionKey = null;
  applyJobInfoNav();
  renderContent();
}

// Update the little count badge on the "Suggested additions" nav item.
async function refreshSuggestionsBadge() {
  const badge = document.getElementById('suggestions-badge');
  if (!badge) return;
  try {
    const data = await api('/unanswered-questions?status=open');
    const n = data.total_groups || 0;
    badge.textContent = String(n);
    badge.style.display = n > 0 ? '' : 'none';
  } catch { badge.style.display = 'none'; }
}

document.getElementById('nav-jobinfo-facts').addEventListener('click', () => setJobInfoView('facts'));
document.getElementById('nav-jobinfo-suggestions').addEventListener('click', () => setJobInfoView('suggestions'));

document.getElementById('new-jobinfo-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('new-jobinfo-name');
  const name = input.value.trim();
  if (!name) return;
  try {
    const job = await api('/jobs', { method: 'POST', body: JSON.stringify({ name }) });
    input.value = '';
    await loadJobs();
    state.jobInfoSelected = job.id;
    renderJobInfoFolderList();
    await renderContent();
    showToast('Folder created');
  } catch (err) { showToast(err.message, true); }
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
  state.recruiterJobs.forEach(job => recruiterFolderListEl.appendChild(buildRecruiterFolderRow(job)));
}

// Mirrors buildFolderRow (Criteria tab): a folder tab plus the shared ⋯ menu
// with Rename / Remove. Recruiter folders have no virtual "General", so every
// one gets the menu.
function buildRecruiterFolderRow(job) {
  const row = document.createElement('div');
  row.className = 'folder-row' + (state.recruiterSelected === job.id ? ' active' : '');

  if (state.renamingRecruiterFolderId === job.id) {
    const input = document.createElement('input');
    input.className = 'folder-rename-input';
    input.value = job.name;
    row.appendChild(input);
    wireRecruiterFolderRename(input, job);
    return row;
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'folder-tab' + (state.recruiterSelected === job.id ? ' active' : '');
  btn.innerHTML = `<span>${escapeHtml(job.name)}</span>`;
  btn.onclick = () => selectRecruiterFolder(job.id);
  row.appendChild(btn);

  row.appendChild(RowMenu.createRowMenu([
    { label: 'Rename', onSelect: () => { state.renamingRecruiterFolderId = job.id; renderRecruiterFolderList(); } },
    { label: 'Remove', variant: 'danger', onSelect: () => confirmRemoveRecruiterFolder(job) },
  ]));
  return row;
}

function wireRecruiterFolderRename(input, job) {
  let settled = false;
  requestAnimationFrame(() => { input.focus(); input.select(); });

  async function save() {
    if (settled) return;
    settled = true;
    const name = input.value.trim();
    state.renamingRecruiterFolderId = null;
    if (!name || name === job.name) { renderRecruiterFolderList(); return; }
    try {
      await api(`/recruiter-jobs/${job.id}`, { method: 'PUT', body: JSON.stringify({ name }) });
      await loadRecruiterJobs(); // refreshes state.recruiterJobs + re-renders the list
      if (state.recruiterSelected === job.id) await renderContent(); // update the header
      showToast('Folder renamed');
    } catch (err) {
      showToast(err.message, true);
      renderRecruiterFolderList();
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { settled = true; state.renamingRecruiterFolderId = null; renderRecruiterFolderList(); }
  });
  input.addEventListener('blur', save);
}

async function confirmRemoveRecruiterFolder(job) {
  // Count recruiters so the confirmation states what will be removed (deleting
  // the folder cascades its recruiter contacts).
  let n = 0;
  try { n = (await api(`/recruiter-jobs/${job.id}/recruiters`)).length; } catch { /* fall back to 0 */ }
  RowMenu.confirmDialog({
    title: 'Delete folder',
    message: `Delete "${job.name}"? This removes the folder and ${plural(n, 'recruiter')} in it. This can't be undone.`,
    confirmLabel: 'Delete',
    onConfirm: async () => {
      await api(`/recruiter-jobs/${job.id}`, { method: 'DELETE' });
      await loadRecruiterJobs();
      // If we deleted the selected folder, fall back to the first remaining one
      // (or the empty state when none are left).
      if (state.recruiterSelected === job.id) {
        state.recruiterSelected = state.recruiterJobs.length ? state.recruiterJobs[0].id : null;
      }
      renderRecruiterFolderList();
      await renderContent();
      showToast('Folder deleted');
    },
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
  `;

  const nameInput = row.querySelector('.r-name');
  const emailInput = row.querySelector('.r-email');
  const calInput = row.querySelector('.r-cal');
  const notesInput = row.querySelector('.r-notes');

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
  // Enter commits the rename (blur triggers the change handler above).
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); } });
  emailInput.addEventListener('change', () => {
    if (!isEmail(emailInput.value)) { emailInput.value = r.email; return showToast('Please enter a valid email', true); }
    save({ email: emailInput.value.trim() });
  });
  calInput.addEventListener('change', () => {
    if (!isUrl(calInput.value)) { calInput.value = r.calendar_link; return showToast('Calendar link must be a valid URL', true); }
    save({ calendar_link: calInput.value.trim() });
  });
  notesInput.addEventListener('change', () => save({ notes: notesInput.value.trim() }));

  row.appendChild(RowMenu.createRowMenu([
    { label: 'Rename', onSelect: () => { nameInput.focus(); nameInput.select(); } },
    {
      label: 'Remove',
      variant: 'danger',
      onSelect: () => RowMenu.confirmDialog({
        title: 'Remove recruiter',
        message: `Remove "${r.name}" from recruiters? This can't be undone.`,
        confirmLabel: 'Remove',
        onConfirm: async () => {
          await api(`/recruiters/${r.id}`, { method: 'DELETE' });
          showToast('Recruiter deleted');
          await renderContent();
        },
      }),
    },
  ]));

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

// ================= JOB INFO =================
// Reuses the shared jobs folders (same identity as Screening). Facts are
// label/value pairs the candidate-facing JobBot agent looks up per job.

function renderJobInfoFolderList() {
  if (!jobinfoFolderListEl) return;
  jobinfoFolderListEl.innerHTML = '';
  // Pinned company-wide folders first: Company FAQ, then General.
  jobinfoFolderListEl.appendChild(buildJobInfoFolderRow({ id: 'companyfaq', name: 'Company FAQ', companyfaq: true }));
  jobinfoFolderListEl.appendChild(buildJobInfoFolderRow({ id: 'general', name: 'General', general: true }));
  const divider = document.createElement('div');
  divider.className = 'folder-divider';
  jobinfoFolderListEl.appendChild(divider);
  // Job Info is intentionally NOT mode-ordered and shows no mode dot — the
  // lifecycle mode belongs to the Screening tab only.
  state.jobs.forEach(job => jobinfoFolderListEl.appendChild(buildJobInfoFolderRow(job)));
}

// Small inline SVG used as the pinned Company FAQ folder glyph.
const FAQ_ICO = '<svg class="folder-tab-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21V6a2 2 0 0 1 2-2h9l4 4v13"/><path d="M14 4v4h4"/><path d="M7 11h6M7 15h4"/></svg>';

function buildJobInfoFolderRow(job) {
  const pinned = job.general || job.companyfaq; // company-wide, non-editable pseudo-folders
  const row = document.createElement('div');
  row.className = 'folder-row' + (state.jobInfoSelected === job.id ? ' active' : '');

  if (!pinned && state.renamingJobInfoFolderId === job.id) {
    const input = document.createElement('input');
    input.className = 'folder-rename-input';
    input.value = job.name;
    row.appendChild(input);
    wireJobInfoFolderRename(input, job);
    return row;
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'folder-tab'
    + (job.general ? ' general' : '')
    + (job.companyfaq ? ' pinned' : '')
    + (state.jobInfoSelected === job.id ? ' active' : '');
  btn.innerHTML = (job.companyfaq ? FAQ_ICO : '') + `<span>${escapeHtml(job.name)}</span>`;
  btn.onclick = () => selectJobInfoFolder(job.id);
  row.appendChild(btn);

  if (!pinned) {
    row.appendChild(RowMenu.createRowMenu([
      { label: 'Rename', onSelect: () => { state.renamingJobInfoFolderId = job.id; renderJobInfoFolderList(); } },
      { label: 'Remove', variant: 'danger', onSelect: () => confirmRemoveFolder(job) },
    ]));
  }
  return row;
}

function wireJobInfoFolderRename(input, job) {
  let settled = false;
  requestAnimationFrame(() => { input.focus(); input.select(); });

  async function save() {
    if (settled) return;
    settled = true;
    const name = input.value.trim();
    state.renamingJobInfoFolderId = null;
    if (!name || name === job.name) { renderJobInfoFolderList(); return; }
    try {
      await api(`/jobs/${job.id}`, { method: 'PUT', body: JSON.stringify({ name }) });
      await loadJobs(); // refreshes both folder lists (same job identity)
      await renderContent();
      showToast('Folder renamed');
    } catch (err) {
      showToast(err.message, true);
      renderJobInfoFolderList();
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { settled = true; state.renamingJobInfoFolderId = null; renderJobInfoFolderList(); }
  });
  input.addEventListener('blur', save);
}

async function selectJobInfoFolder(id) {
  state.jobInfoSelected = id;
  state.editingFactId = null;
  renderJobInfoFolderList();
  await renderContent();
}

async function renderJobInfoView() {
  const id = state.jobInfoSelected;
  if (id === 'companyfaq') { await renderCompanyFaqView(); return; }
  const isGeneral = id === 'general';
  const job = isGeneral ? null : state.jobs.find(j => j.id === id);
  if (!isGeneral && !job) { state.jobInfoSelected = 'general'; return renderJobInfoView(); }

  const name = isGeneral ? 'General' : job.name;
  const scopeId = isGeneral ? 'general' : job.id;
  const lookupKey = isGeneral ? '' : encodeURIComponent(job.ashby_job_id || job.name);

  contentEl.innerHTML = `
    <div class="folder-label">Job Info</div>
    <h1 class="folder-title">${escapeHtml(name)}</h1>
    <div class="folder-meta">${isGeneral
      ? 'Facts that apply to every job. JobBot includes these alongside each job’s own facts.'
      : `Facts the JobBot voice agent can answer for this role. Fetched via <span class="mono">GET /api/jobinfo/lookup?job=${escapeHtml(lookupKey)}</span>.`}</div>
    <div class="section" id="jobinfo-facts"></div>`;

  let facts;
  try {
    facts = await api(`/jobs/${scopeId}/job-info`);
  } catch (err) {
    document.getElementById('jobinfo-facts').innerHTML = `<div class="empty-state">Could not load facts: ${escapeHtml(err.message)}</div>`;
    return;
  }
  renderFactsSection(document.getElementById('jobinfo-facts'), facts, scopeId);
}

// ================= COMPANY FAQ (company-wide, role-independent) =================
// A single flat list of label/value facts JobBot can answer for ANY candidate
// regardless of role. Read live by the voice workflow via
// GET /api/jobbot/global-faq. Mirrors the Job Info facts editor but with no
// folders and its own /company-faq endpoints.
async function renderCompanyFaqView() {
  contentEl.innerHTML = `
    <div class="folder-label">Company FAQ</div>
    <h1 class="folder-title">Company FAQ</h1>
    <div class="folder-meta">Company-wide facts that apply to every candidate, regardless of role — offices, funding, values, interview process. Fetched by the JobBot voice agent via <span class="mono">GET /api/jobbot/global-faq</span>.</div>
    <div class="section" id="companyfaq-facts"></div>`;

  let facts;
  try {
    facts = await api('/company-faq');
  } catch (err) {
    document.getElementById('companyfaq-facts').innerHTML = `<div class="empty-state">Could not load Company FAQ: ${escapeHtml(err.message)}</div>`;
    return;
  }
  renderCompanyFaqSection(document.getElementById('companyfaq-facts'), facts);
}

function renderCompanyFaqSection(container, facts) {
  container.innerHTML = `
    <div class="section-heading">
      <h2>Company facts</h2>
      <span class="weight-total">${facts.length} ${facts.length === 1 ? 'fact' : 'facts'}</span>
    </div>
    <div class="section-hint">Label + value pairs any candidate might ask JobBot about — office locations, funding, company values, interview process… These apply to every role.</div>
    <div class="fact-list" id="companyfaq-fact-list"></div>
    <form class="add-fact-form" id="add-companyfaq-form">
      <input type="text" name="label" placeholder="Label (e.g. Offices)" required />
      <input type="text" name="value" placeholder="Value (e.g. San Francisco, Madrid…)" required />
      <button type="submit" title="Add fact">+</button>
    </form>`;

  const listEl = container.querySelector('#companyfaq-fact-list');
  if (!facts.length) {
    listEl.innerHTML = `<div class="empty-state">No facts yet. Add the first one below.</div>`;
  } else {
    facts.forEach(f => listEl.appendChild(buildFactBanner(f, 'company-faq')));
  }

  container.querySelector('#add-companyfaq-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const label = form.label.value.trim();
    const value = form.value.value.trim();
    if (!label || !value) return;
    try {
      await api('/company-faq', { method: 'POST', body: JSON.stringify({ label, value }) });
      showToast('Fact added');
      await renderContent();
    } catch (err) { showToast(err.message, true); }
  });
}

function renderFactsSection(container, facts, scopeId) {
  container.innerHTML = `
    <div class="section-heading">
      <h2>Job facts</h2>
      <span class="weight-total">${facts.length} ${facts.length === 1 ? 'fact' : 'facts'}</span>
    </div>
    <div class="section-hint">Label + value pairs a candidate might ask JobBot about — salary, location, remote policy, start date, benefits… Add whatever matters for this role.</div>
    <div class="fact-list" id="fact-list"></div>
    <form class="add-fact-form" id="add-fact-form">
      <input type="text" name="label" placeholder="Label (e.g. Salary range)" required />
      <input type="text" name="value" placeholder="Value (e.g. $80k–100k)" required />
      <button type="submit" title="Add fact">+</button>
    </form>`;

  const listEl = container.querySelector('#fact-list');
  if (!facts.length) {
    listEl.innerHTML = `<div class="empty-state">No facts yet. Add the first one below.</div>`;
  } else {
    facts.forEach(f => listEl.appendChild(buildFactBanner(f)));
  }

  container.querySelector('#add-fact-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const label = form.label.value.trim();
    const value = form.value.value.trim();
    if (!label || !value) return;
    try {
      await api(`/jobs/${scopeId}/job-info`, { method: 'POST', body: JSON.stringify({ label, value }) });
      showToast('Fact added');
      await renderContent();
    } catch (err) { showToast(err.message, true); }
  });
}

// `resource` is the REST base for edit/delete of a single fact: 'job-info' for
// per-role Job Info facts (PUT/DELETE /api/job-info/:id) or 'company-faq' for
// the Company FAQ (PUT/DELETE /api/company-faq/:id). Both share this identical
// collapsible label/value banner UI.
function buildFactBanner(f, resource = 'job-info') {
  const el = document.createElement('div');
  el.className = 'fact-banner';

  if (state.editingFactId === f.id) {
    el.classList.add('editing');
    el.innerHTML = `
      <div class="fact-edit">
        <input class="fact-label-input" value="${escapeHtml(f.label)}" placeholder="Label" />
        <input class="fact-value-input" value="${escapeHtml(f.value)}" placeholder="Value" />
      </div>
      <button class="fact-save" type="button">Save</button>`;
    const labelI = el.querySelector('.fact-label-input');
    const valueI = el.querySelector('.fact-value-input');
    const save = async () => {
      const label = labelI.value.trim();
      const value = valueI.value.trim();
      if (!label || !value) { showToast('Label and value are required', true); return; }
      state.editingFactId = null;
      try {
        await api(`/${resource}/${f.id}`, { method: 'PUT', body: JSON.stringify({ label, value }) });
        showToast('Fact updated');
        await renderContent();
      } catch (err) { showToast(err.message, true); await renderContent(); }
    };
    el.querySelector('.fact-save').addEventListener('click', save);
    [labelI, valueI].forEach(inp => inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      else if (e.key === 'Escape') { state.editingFactId = null; renderContent(); }
    }));
    requestAnimationFrame(() => { labelI.focus(); labelI.select(); });
    return el;
  }

  // Collapsed by default: only the label shows until the card is clicked.
  const expanded = state.expandedFacts.has(f.id);
  el.classList.add('collapsible');
  if (expanded) el.classList.add('expanded');
  el.innerHTML = `
    <div class="fact-body">
      <div class="fact-label">${escapeHtml(f.label)}</div>
      <div class="fact-value">${escapeHtml(f.value)}</div>
    </div>
    <div class="fact-actions"></div>`;

  const actions = el.querySelector('.fact-actions');
  actions.appendChild(RowMenu.createRowMenu([
    { label: 'Edit', onSelect: () => { state.editingFactId = f.id; renderContent(); } },
    {
      label: 'Remove',
      variant: 'danger',
      onSelect: () => RowMenu.confirmDialog({
        title: 'Remove fact',
        message: `Remove "${f.label}"? This can't be undone.`,
        confirmLabel: 'Remove',
        onConfirm: async () => {
          await api(`/${resource}/${f.id}`, { method: 'DELETE' });
          state.expandedFacts.delete(f.id);
          showToast('Fact removed');
          await renderContent();
        },
      }),
    },
  ]));

  const chevron = document.createElement('span');
  chevron.className = 'fact-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = expanded ? '˄' : '˅';
  actions.appendChild(chevron);

  // Clicking the card (label, value, or chevron) toggles; the ⋯ trigger stops
  // propagation so it won't toggle. Toggle just this card for smooth,
  // independent open/close without a full re-render.
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-expanded', String(expanded));
  const toggle = () => {
    const nowExpanded = !state.expandedFacts.has(f.id);
    if (nowExpanded) state.expandedFacts.add(f.id);
    else state.expandedFacts.delete(f.id);
    el.classList.toggle('expanded', nowExpanded);
    el.setAttribute('aria-expanded', String(nowExpanded));
    chevron.textContent = nowExpanded ? '˄' : '˅';
  };
  el.addEventListener('click', toggle);
  // Keyboard access: the card has role="button", so Enter/Space must toggle it too.
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
  return el;
}

// ---------- Suggested additions (unanswered questions) ----------
// Questions JobBot couldn't answer, grouped by exact text and ranked by how
// often they were asked. Recruiters turn one into a Job Info fact or dismiss it.

async function renderSuggestionsView() {
  contentEl.innerHTML = `
    <div class="folder-label">Job Info</div>
    <h1 class="folder-title">Suggested additions</h1>
    <div class="folder-meta">Questions JobBot couldn’t answer from the current facts, grouped by exact wording and ranked by how often candidates asked. Add an answer to turn one into a Job Info fact, or dismiss it.</div>
    <div class="section" id="suggestions-section"><div class="empty-state">Loading…</div></div>`;

  const section = document.getElementById('suggestions-section');
  let data;
  try {
    data = await api('/unanswered-questions?status=open');
  } catch (err) {
    section.innerHTML = `<div class="empty-state">Could not load suggestions: ${escapeHtml(err.message)}</div>`;
    return;
  }

  const groups = data.groups || [];
  if (!groups.length) {
    section.innerHTML = `<div class="empty-state">No open questions. When JobBot can’t answer something, it’ll show up here.</div>`;
    return;
  }

  section.innerHTML = `
    <div class="section-heading">
      <h2>Open questions</h2>
      <span class="weight-total">${groups.length} ${groups.length === 1 ? 'question' : 'questions'}</span>
    </div>
    <div class="suggestion-list" id="suggestion-list"></div>`;
  const listEl = section.querySelector('#suggestion-list');
  groups.forEach((g) => listEl.appendChild(buildSuggestionRow(g)));
}

function buildSuggestionRow(g) {
  const key = g.ids[0]; // stable identity for the open/closed add form
  const el = document.createElement('div');
  el.className = 'suggestion-card';

  const roles = (g.role_labels || []).filter(Boolean);
  const roleHtml = roles.length
    ? roles.map((r) => `<span class="suggestion-role">${escapeHtml(r)}</span>`).join('')
    : '<span class="suggestion-role muted">No role reported</span>';

  el.innerHTML = `
    <div class="suggestion-main">
      <div class="suggestion-question">${escapeHtml(g.question_text)}</div>
      <div class="suggestion-meta">
        <span class="suggestion-count">asked ${g.count}×</span>
        ${roleHtml}
        <span class="suggestion-date mono muted">last ${fmtDate(g.last_seen)}</span>
      </div>
    </div>
    <div class="suggestion-actions">
      <button type="button" class="btn-add">Add to Job Info</button>
      <button type="button" class="btn-dismiss">Dismiss</button>
    </div>`;

  el.querySelector('.btn-add').addEventListener('click', () => {
    state.openSuggestionKey = state.openSuggestionKey === key ? null : key;
    renderContent();
  });

  el.querySelector('.btn-dismiss').addEventListener('click', () => {
    RowMenu.confirmDialog({
      title: 'Dismiss question',
      message: `Dismiss “${g.question_text}”? It won’t show up again. This clears ${g.count} matching open ${g.count === 1 ? 'entry' : 'entries'}.`,
      confirmLabel: 'Dismiss',
      onConfirm: async () => {
        try {
          await api('/unanswered-questions/dismiss', { method: 'POST', body: JSON.stringify({ ids: g.ids }) });
          state.openSuggestionKey = null;
          showToast('Question dismissed');
          await refreshSuggestionsBadge();
          await renderContent();
        } catch (err) { showToast(err.message, true); }
      },
    });
  });

  if (state.openSuggestionKey === key) {
    el.classList.add('expanded');
    el.appendChild(buildSuggestionAddForm(g));
  }
  return el;
}

function buildSuggestionAddForm(g) {
  const form = document.createElement('form');
  form.className = 'suggestion-add-form';

  // Default the target folder to a job whose name matches a reported role label.
  const roleLc = (g.role_labels || []).map((r) => r.trim().toLowerCase());
  const match = state.jobs.find((j) => roleLc.includes(j.name.trim().toLowerCase()));
  const options = [`<option value="general">General (all jobs)</option>`]
    .concat(state.jobs.map((j) => `<option value="${escapeHtml(j.id)}"${match && match.id === j.id ? ' selected' : ''}>${escapeHtml(j.name)}</option>`))
    .join('');

  form.innerHTML = `
    <div class="suggestion-add-grid">
      <label class="suggestion-add-field">
        <span class="setting-desc">Folder</span>
        <select name="job_id" class="suggestion-folder">${options}</select>
      </label>
      <label class="suggestion-add-field">
        <span class="setting-desc">Label</span>
        <input type="text" name="label" placeholder="e.g. Visa sponsorship" required />
      </label>
      <label class="suggestion-add-field">
        <span class="setting-desc">Answer (value)</span>
        <input type="text" name="value" placeholder="The answer JobBot should give" required />
      </label>
    </div>
    <div class="suggestion-add-actions">
      <button type="submit" class="btn-add">Save fact & resolve</button>
      <button type="button" class="btn-cancel">Cancel</button>
    </div>`;

  form.querySelector('.btn-cancel').addEventListener('click', () => {
    state.openSuggestionKey = null;
    renderContent();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const job_id = form.job_id.value;
    const label = form.label.value.trim();
    const value = form.value.value.trim();
    if (!label || !value) { showToast('Label and answer are required', true); return; }
    try {
      const r = await api('/unanswered-questions/add-to-job-info', {
        method: 'POST',
        body: JSON.stringify({ ids: g.ids, job_id, label, value }),
      });
      state.openSuggestionKey = null;
      showToast(`Fact added · ${r.resolved} ${r.resolved === 1 ? 'question' : 'questions'} resolved`);
      await refreshSuggestionsBadge();
      await renderContent();
    } catch (err) { showToast(err.message, true); }
  });

  // Don't let clicks inside the form bubble to the card.
  form.addEventListener('click', (e) => e.stopPropagation());
  requestAnimationFrame(() => { const l = form.querySelector('input[name="label"]'); if (l) l.focus(); });
  return form;
}

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
  return score >= passThreshold() ? 'pass' : 'fail';
}

// Segmented Timeline / Analytics control shown atop both History sub-views.
function historyToggleHtml(active) {
  return `
    <div class="seg-toggle" id="history-toggle">
      <button type="button" class="seg-item ${active === 'timeline' ? 'active' : ''}" data-view="timeline">Timeline</button>
      <button type="button" class="seg-item ${active === 'analytics' ? 'active' : ''}" data-view="analytics">Analytics</button>
    </div>`;
}

function wireHistoryToggle() {
  const el = document.getElementById('history-toggle');
  if (!el) return;
  el.querySelectorAll('.seg-item').forEach((b) => b.addEventListener('click', () => {
    const view = b.dataset.view;
    if (view === state.historyView) return;
    state.historyView = view;
    state.historyApp = null;
    renderContent();
  }));
}

async function renderHistoryList() {
  contentEl.innerHTML = `
    <div class="folder-label">Evaluation history</div>
    <h1 class="folder-title">History</h1>
    <div class="folder-meta">Every application that has been evaluated across Prescreen and Agent Interview.</div>
    ${historyToggleHtml('timeline')}
    <div class="section" id="history-section"><div class="empty-state">Loading…</div></div>`;
  wireHistoryToggle();

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
        <div class="hist-app">
          <span class="avatar">${escapeHtml(initials(r.job_name || r.application_id))}</span>
          <span class="mono">${escapeHtml(r.application_id)}</span>
        </div>
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

// ---------- Analytics sub-view (aggregate funnel) ----------
async function renderAnalytics() {
  contentEl.innerHTML = `
    <div class="folder-label">Evaluation history</div>
    <h1 class="folder-title">History</h1>
    <div class="folder-meta">Aggregate funnel across all evaluated candidates. Later Ashby stages (Recruiter Interview / Hired / Archived) live in Ashby and aren't tracked here.</div>
    ${historyToggleHtml('analytics')}
    <div class="analytics-controls">
      <label class="analytics-filter">
        <span class="setting-desc">Job</span>
        <select id="analytics-job"><option value="">All jobs</option></select>
      </label>
    </div>
    <div class="section" id="analytics-section"><div class="empty-state">Loading…</div></div>`;
  wireHistoryToggle();

  // Populate the job filter from the shared jobs list.
  const sel = document.getElementById('analytics-job');
  state.jobs.forEach((j) => {
    const o = document.createElement('option');
    o.value = j.id; o.textContent = j.name;
    if (j.id === state.analyticsJob) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => { state.analyticsJob = sel.value; renderContent(); });

  const section = document.getElementById('analytics-section');
  let data;
  try {
    data = await api(`/analytics/funnel${state.analyticsJob ? `?job=${encodeURIComponent(state.analyticsJob)}` : ''}`);
  } catch (err) {
    section.innerHTML = `<div class="empty-state">Could not load analytics: ${escapeHtml(err.message)}</div>`;
    return;
  }

  const applied = data.stages[0] ? data.stages[0].count : 0;
  const fmtPct = (v) => (v == null ? '—' : `${v}%`);
  const fmtNum = (v) => (v == null ? '—' : v);

  const funnelHtml = data.stages.map((st, i) => {
    const pct = applied > 0 ? Math.round((st.count / applied) * 100) : 0;
    const conv = i === 0 ? '' : `<span class="funnel-conv">${fmtPct(st.conversion)} of previous</span>`;
    return `
      <div class="funnel-stage">
        <div class="funnel-top">
          <span class="funnel-label">${escapeHtml(st.label)}</span>
          <span class="funnel-count">${st.count}${conv}</span>
        </div>
        <div class="funnel-bar"><div class="funnel-fill" style="width:${pct}%"></div></div>
      </div>`;
  }).join('');

  const m = data.metrics || {};
  const metricTiles = [
    { label: 'Avg Prescreen score', value: m.avg_prescreen_score == null ? '—' : `${m.avg_prescreen_score} / 10` },
    { label: 'Avg Interview score', value: m.avg_interview_score == null ? '—' : `${m.avg_interview_score} / 10` },
    { label: 'Avg call attempts', value: fmtNum(m.avg_attempts) },
    { label: 'Prescreen pass rate', value: fmtPct(m.prescreen_pass_rate) },
    { label: 'Interview pass rate', value: fmtPct(m.interview_pass_rate) },
  ].map((t) => `<div class="metric-tile"><div class="metric-value">${escapeHtml(String(t.value))}</div><div class="metric-label">${escapeHtml(t.label)}</div></div>`).join('');

  let byJobHtml = '';
  if (data.by_job && data.by_job.length) {
    const rows = data.by_job.map((j) => `
      <div class="history-row">
        <div>${escapeHtml(j.job_name)}</div>
        <div class="mono">${j.applied}</div>
        <div class="mono">${fmtPct(j.prescreen_pass_rate)}</div>
        <div class="mono">${fmtPct(j.interview_pass_rate)}</div>
      </div>`).join('');
    byJobHtml = `
      <div class="section">
        <div class="section-heading"><h2>Pass rate by job</h2></div>
        <div class="card">
          <div class="history-row history-head byjob-row"><div>Job</div><div>Applied</div><div>Prescreen pass</div><div>Interview pass</div></div>
          <div class="byjob-rows">${rows}</div>
        </div>
      </div>`;
  }

  section.innerHTML = `
    <div class="section">
      <div class="section-heading">
        <h2>Funnel${data.job ? ` · ${escapeHtml(data.job.name)}` : ''}</h2>
        <span class="weight-total">${applied} candidate${applied === 1 ? '' : 's'}</span>
      </div>
      <div class="card funnel-card">${data.stages.length ? funnelHtml : '<div class="empty-state">No data yet.</div>'}</div>
    </div>
    <div class="section">
      <div class="section-heading"><h2>Metrics</h2></div>
      <div class="metric-grid">${metricTiles}</div>
    </div>
    ${byJobHtml}`;

  // .byjob-row grid columns match the 4-column layout.
  section.querySelectorAll('.byjob-row, .byjob-rows .history-row').forEach((r) => {
    r.style.gridTemplateColumns = '2fr 1fr 1.2fr 1.2fr';
  });
}

// Horizontal score bar (0–10) with the configurable pass threshold marked.
function scoreGauge(score, label) {
  const threshold = passThreshold();
  const s = score == null ? 0 : Math.max(0, Math.min(10, score));
  const pct = (s / 10) * 100;
  const threshPct = (Math.max(0, Math.min(10, threshold)) / 10) * 100;
  const cls = score == null ? 'muted' : (score >= threshold ? 'pass' : 'fail');
  return `
    <div class="chart-block">
      <div class="chart-title">${escapeHtml(label)}</div>
      <div class="gauge">
        <div class="gauge-fill ${cls}" style="width:${pct}%"></div>
        <div class="gauge-threshold" style="left:${threshPct}%" title="Pass threshold: ${threshold}/10"></div>
      </div>
      <div class="gauge-scale"><span>0</span><span class="gauge-mark">pass ≥ ${threshold}</span><span>10</span></div>
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

// Pass/fail is whether the answer MATCHES the question's expected answer — not
// whether it's simply "true". expected null (e.g. a since-deleted question)
// means we can't judge, so show the raw answer without a verdict.
function answerChip(answer, expected) {
  if (answer !== true && answer !== false) return '<span class="ans ans-na">not asked</span>';
  const label = answer ? 'TRUE' : 'FALSE';
  if (expected === null || expected === undefined) return `<span class="ans ans-na">${label}</span>`;
  const matched = answer === expected;
  return `<span class="ans ${matched ? 'ans-yes' : 'ans-no'}">${label} · ${matched ? 'pass' : 'fail'}</span>`;
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
            <div class="q-text">${escapeHtml(q.text)}${q.weight != null && q.weight !== 1 ? ` <span class="q-weight mono">×${q.weight} weight</span>` : ''}${q.expected_answer === false ? ` <span class="q-weight mono">expects False</span>` : ''}</div>
            <div>${answerChip(q.answer, q.expected_answer)}</div>
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

async function loadSettings() {
  try { state.settings = await api('/settings'); }
  catch { state.settings = null; }
}

// ================= SETTINGS VIEW =================

function setSettingsView() {
  state.section = 'settings';
  state.testingJobId = null;
  document.getElementById('section-screening').classList.remove('active');
  document.getElementById('section-recruiters').classList.remove('active');
  document.getElementById('section-jobinfo').classList.remove('active');
  document.getElementById('nav-settings').classList.add('active');
  document.getElementById('screening-section').style.display = 'none';
  document.getElementById('recruiters-section').style.display = 'none';
  document.getElementById('jobinfo-section').style.display = 'none';
  renderSettingsView();
}

async function saveSetting(patch, msg) {
  try {
    const updated = await api('/settings', { method: 'PUT', body: JSON.stringify(patch) });
    state.settings = { ...state.settings, ...updated };
    showToast(msg || 'Setting saved');
  } catch (err) { showToast(err.message, true); }
}

async function renderSettingsView() {
  contentEl.innerHTML = `<div class="empty-state">Loading…</div>`;
  let s;
  try {
    s = await api('/settings');
    state.settings = s;
  } catch (err) {
    contentEl.innerHTML = `<div class="empty-state">Could not load settings: ${escapeHtml(err.message)}</div>`;
    return;
  }

  const secrets = s.secrets || [];
  const ashby = s.ashby || {};

  contentEl.innerHTML = `
    <div class="folder-label">Workspace</div>
    <h1 class="folder-title">Settings</h1>
    <div class="folder-meta">Runtime configuration for scoring and the Agent Interview. Changes apply immediately across the app and the workflows that read from it.</div>

    <div class="section">
      <div class="section-heading"><h2>Scoring</h2></div>
      <div class="section-hint">The score a candidate must reach to be marked as passing. Applies to the Agent Interview pass/fail decision and to how Prescreen and Interview scores are shown in History.</div>
      <div class="card">
        <div class="setting-row">
          <div class="setting-label">
            <div class="setting-title">Pass threshold</div>
            <div class="setting-desc">Out of 10. A score at or above this counts as a pass.</div>
          </div>
          <div class="setting-control">
            <input type="number" id="set-threshold" min="0" max="10" step="0.5" value="${escapeHtml(String(s.pass_threshold))}" />
            <span class="setting-unit">/ 10</span>
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-heading"><h2>Agent Interview</h2></div>
      <div class="section-hint">Controls for the automated interview-call phase.</div>
      <div class="card">
        <div class="setting-row">
          <div class="setting-label">
            <div class="setting-title">Max call attempts</div>
            <div class="setting-desc">Zero-engagement retries before an application is archived as unreachable.</div>
          </div>
          <div class="setting-control">
            <input type="number" id="set-attempts" min="1" step="1" value="${escapeHtml(String(s.max_call_attempts))}" />
            <span class="setting-unit">attempts</span>
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-label">
            <div class="setting-title">Call recording</div>
            <div class="setting-desc">Whether the voice agent records Agent Interview calls (surfaced to the agent on lookup).</div>
          </div>
          <div class="setting-control">
            <label class="toggle">
              <input type="checkbox" id="set-recording" ${s.call_recording_enabled ? 'checked' : ''} />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-heading"><h2>Ashby connection</h2></div>
      <div class="section-hint">Read-only. Configured via environment variables on the server.</div>
      <div class="card">
        <div class="setting-row">
          <div class="setting-label">
            <div class="setting-title">API status</div>
            <div class="setting-desc">Live connectivity check against the Ashby API.</div>
          </div>
          <div class="setting-control" id="ashby-status"><span class="pill muted">Checking…</span></div>
        </div>
        <div class="setting-row">
          <div class="setting-label">
            <div class="setting-title">Object type</div>
            <div class="setting-desc">Where interview custom fields live.</div>
          </div>
          <div class="setting-control"><span class="settings-value mono">${escapeHtml(ashby.object_type || '—')}</span></div>
        </div>
        <div class="setting-row">
          <div class="setting-label">
            <div class="setting-title">Interview Score field</div>
            <div class="setting-desc">Ashby custom field the interview score is written to.</div>
          </div>
          <div class="setting-control"><span class="settings-value mono">${escapeHtml(ashby.interview_score_field_id || 'not mapped')}</span></div>
        </div>
        <div class="setting-row">
          <div class="setting-label">
            <div class="setting-title">Questions Asked field</div>
            <div class="setting-desc">Ashby custom field the coverage (asked/total) is written to.</div>
          </div>
          <div class="setting-control"><span class="settings-value mono">${escapeHtml(ashby.questions_asked_field_id || 'not mapped')}</span></div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-heading"><h2>API keys &amp; secrets</h2></div>
      <div class="section-hint">Read-only. Masked by default — the raw value is fetched only when you click <span class="mono">Reveal</span> or <span class="mono">Copy</span>, never in the page's initial load.</div>
      <div class="card">
        ${secrets.map((sec) => `
          <div class="setting-row">
            <div class="setting-label">
              <div class="setting-title">${escapeHtml(sec.label)}</div>
              <div class="setting-desc">${escapeHtml(sec.hint || '')}</div>
            </div>
            <div class="setting-control">
              ${sec.configured
                ? `<span class="settings-value mono secret-value" data-key="${escapeHtml(sec.key)}" data-masked="${escapeHtml(sec.masked || '')}">${escapeHtml(sec.masked || '')}</span>
                   <button type="button" class="reveal-btn secret-reveal" data-key="${escapeHtml(sec.key)}">Reveal</button>
                   <button type="button" class="reveal-btn secret-copy" data-key="${escapeHtml(sec.key)}">Copy</button>`
                : `<span class="pill muted">Not configured</span>`}
            </div>
          </div>`).join('')}
      </div>
    </div>
  `;

  document.getElementById('set-threshold').addEventListener('change', (e) => {
    saveSetting({ pass_threshold: Number(e.target.value) }, 'Pass threshold updated');
  });
  document.getElementById('set-attempts').addEventListener('change', (e) => {
    saveSetting({ max_call_attempts: Number(e.target.value) }, 'Max attempts updated');
  });
  document.getElementById('set-recording').addEventListener('change', (e) => {
    saveSetting({ call_recording_enabled: e.target.checked }, `Call recording ${e.target.checked ? 'enabled' : 'disabled'}`);
  });

  // Reveal/hide each secret. Reveal fetches the raw value on demand (it is not
  // in the initial /settings payload); Hide restores the masked form.
  document.querySelectorAll('.secret-reveal').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.key;
      const valEl = document.querySelector(`.secret-value[data-key="${key}"]`);
      if (!valEl) return;
      if (valEl.dataset.shown) {
        valEl.textContent = valEl.dataset.masked || '';
        delete valEl.dataset.shown;
        delete valEl.dataset.raw;
        btn.textContent = 'Reveal';
        return;
      }
      btn.disabled = true;
      try {
        const r = await api(`/settings/secrets/${key}`);
        valEl.textContent = r.value || '(empty)';
        valEl.dataset.raw = r.value || '';
        valEl.dataset.shown = '1';
        btn.textContent = 'Hide';
      } catch (err) { showToast(err.message, true); }
      finally { btn.disabled = false; }
    });
  });

  // Copy the raw secret to the clipboard (fetches it if not already revealed).
  document.querySelectorAll('.secret-copy').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.key;
      const valEl = document.querySelector(`.secret-value[data-key="${key}"]`);
      try {
        let raw = valEl && valEl.dataset.raw;
        if (!raw) { const r = await api(`/settings/secrets/${key}`); raw = r.value || ''; }
        if (!raw) { showToast('Nothing to copy', true); return; }
        const ok = await copyText(raw);
        showToast(ok ? 'Copied to clipboard' : 'Copy failed', !ok);
      } catch (err) { showToast(err.message, true); }
    });
  });

  // Live Ashby connectivity check (async so the page renders instantly).
  const statusEl = document.getElementById('ashby-status');
  api('/settings/ashby-status').then((st) => {
    if (!st.configured) { statusEl.innerHTML = `<span class="pill muted">Not configured</span>`; return; }
    statusEl.innerHTML = st.connected
      ? `<span class="pill pass">Connected</span>`
      : `<span class="pill fail">Not connected</span>${st.error ? ` <span class="setting-desc">${escapeHtml(st.error)}</span>` : ''}`;
  }).catch(() => { statusEl.innerHTML = `<span class="pill fail">Check failed</span>`; });
}

(async function init() {
  await Promise.all([loadJobs(), loadSettings()]);
  await renderContent();
})();
