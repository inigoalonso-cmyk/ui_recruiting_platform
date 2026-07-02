const state = {
  jobs: [],
  selected: 'general', // 'general' or job.id
};

const contentEl = document.getElementById('content');
const folderListEl = document.getElementById('folder-list');
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
  renderFolderList();
  await renderContent();
}

async function renderContent() {
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

(async function init() {
  await loadJobs();
  await renderContent();
})();
