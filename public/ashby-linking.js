// Ashby job linking picker + subfolder helper (Model B). Loaded after app.js, so
// it reuses the globals api(), showToast(), escapeHtml(), loadJobs(), selectFolder().
// Kept < 500 lines per project rule. Exposes window.AshbyLink.
(function () {
  // The Open-Ashby-jobs list is identical for every folder and rarely changes during a
  // session, so cache it client-side. The picker then opens instantly (no round-trip)
  // after the first load. AshbyLink.refreshJobs() clears it (e.g. after a Sync).
  let openJobsCache = null; // { at: epoch_ms, jobs: [...] }
  const OPEN_JOBS_TTL_MS = 3 * 60 * 1000;
  async function getOpenJobs() {
    if (openJobsCache && Date.now() - openJobsCache.at < OPEN_JOBS_TTL_MS) return openJobsCache.jobs;
    const res = await api('/ashby/jobs');
    openJobsCache = { at: Date.now(), jobs: (res && res.jobs) || [] };
    return openJobsCache.jobs;
  }

  // The full links list (all folders) is small and only changes when someone links/
  // unlinks or runs a Sync — so cache it client-side too. This kills the per-folder-
  // open round-trip to /ashby/links that made opening a folder feel slow. Cleared on
  // any link/unlink and by refreshJobs() (after a Sync).
  let linksCache = null; // { at, links }
  const LINKS_TTL_MS = 60 * 1000;
  async function getAllLinks() {
    if (linksCache && Date.now() - linksCache.at < LINKS_TTL_MS) return linksCache.links;
    const res = await api('/ashby/links');
    linksCache = { at: Date.now(), links: res || [] };
    return linksCache.links;
  }
  const clearLinksCache = () => { linksCache = null; };
  const cachesWarm = () =>
    linksCache && Date.now() - linksCache.at < LINKS_TTL_MS
    && openJobsCache && Date.now() - openJobsCache.at < OPEN_JOBS_TTL_MS;

  // Render the "Ashby jobs" picker for a folder into mountEl: current links (with
  // unlink) + a dropdown of Open Ashby jobs (ones linked elsewhere are greyed).
  async function renderPicker(mountEl, job) {
    if (!mountEl) return;
    // Only show the loading state when we'll actually hit the network — if both
    // caches are warm the picker renders instantly with no flash.
    if (!cachesWarm()) {
      mountEl.innerHTML = '<div class="ashby-link-box"><div class="ashby-muted">Loading Ashby jobs…</div></div>';
    }
    let allLinks; let openJobs;
    try {
      // Both come from client-side caches after the first load, so re-opening any
      // folder is instant (no round-trip). One links list carries every folder's
      // links, so we derive this folder's links + the "linked elsewhere" set from it.
      [allLinks, openJobs] = await Promise.all([
        getAllLinks(),
        getOpenJobs(),
      ]);
    } catch (err) {
      mountEl.innerHTML = `<div class="ashby-link-box"><div class="ashby-error">Could not load Ashby jobs: ${escapeHtml(err.message)}</div></div>`;
      return;
    }

    const links = (allLinks || []).filter((l) => l.job_id === job.id);
    const elsewhere = new Map(); // ashby_job_id -> folder name (linked to a DIFFERENT folder)
    (allLinks || []).forEach((l) => { if (l.job_id !== job.id) elsewhere.set(l.ashby_job_id, l.folder_name); });

    const currentHtml = (links && links.length)
      ? links.map((l) => `<div class="ashby-link-row"><span class="ashby-link-title">${escapeHtml(l.ashby_job_title || l.ashby_job_id)}</span><button type="button" class="ashby-unlink" data-link="${escapeHtml(l.id)}">Unlink</button></div>`).join('')
      : '<div class="ashby-muted">No Ashby jobs linked yet.</div>';

    const optionsHtml = openJobs.map((j) => {
      const taken = elsewhere.get(j.id);
      const label = taken ? `${j.title} — already in “${taken}”` : j.title;
      return `<option value="${escapeHtml(j.id)}" data-title="${escapeHtml(j.title)}"${taken ? ' disabled' : ''}>${escapeHtml(label)}</option>`;
    }).join('');

    // One Ashby job per folder: only offer the picker when nothing is linked yet.
    const addHtml = (links && links.length)
      ? ''
      : `<div class="ashby-link-add">
          <select class="ashby-link-select"><option value="">+ Link an Ashby job…</option>${optionsHtml}</select>
          <button type="button" class="btn-secondary ashby-link-btn">Link</button>
        </div>`;
    mountEl.innerHTML = `
      <div class="ashby-link-box">
        <div class="ashby-link-current">${currentHtml}</div>
        ${addHtml}
      </div>`;

    mountEl.querySelectorAll('.ashby-unlink').forEach((b) => b.addEventListener('click', async () => {
      try {
        await api(`/jobs/${job.id}/ashby-links/${b.dataset.link}`, { method: 'DELETE' });
        showToast('Unlinked');
        clearLinksCache();
        await loadJobs();
        renderPicker(mountEl, job);
      } catch (e) { showToast(e.message, true); }
    }));

    const sel = mountEl.querySelector('.ashby-link-select');
    const addBtn = mountEl.querySelector('.ashby-link-btn');
    if (addBtn && sel) addBtn.addEventListener('click', async () => {
      const opt = sel.options[sel.selectedIndex];
      if (!opt || !opt.value) { showToast('Pick an Ashby job first', true); return; }
      try {
        await api(`/jobs/${job.id}/ashby-links`, {
          method: 'POST',
          body: JSON.stringify({ ashby_job_id: opt.value, ashby_job_title: opt.dataset.title }),
        });
        showToast('Linked');
        clearLinksCache();
        await loadJobs();
        renderPicker(mountEl, job);
      } catch (e) { showToast(e.message, true); }
    });
  }

  // Create a variant subfolder under a top-level role folder.
  async function createSubfolder(parentJob) {
    const name = window.prompt(`New variant folder under “${parentJob.name}” (e.g. "${parentJob.name} — Japan"):`);
    if (!name || !name.trim()) return;
    try {
      const child = await api('/jobs', { method: 'POST', body: JSON.stringify({ name: name.trim(), parent_id: parentJob.id }) });
      showToast('Variant created');
      await loadJobs();
      if (typeof selectFolder === 'function' && child && child.id) selectFolder(child.id);
    } catch (e) { showToast(e.message, true); }
  }

  window.AshbyLink = { renderPicker, createSubfolder, refreshJobs: () => { openJobsCache = null; linksCache = null; } };
})();
