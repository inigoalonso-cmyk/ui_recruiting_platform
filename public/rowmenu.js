// Reusable "row context menu" + confirmation dialog, shared by the Criteria
// folder list and the Recruiters rows. No dependencies. Exposes window.RowMenu.
//
//   RowMenu.createRowMenu(items)  -> a "⋯" trigger <button> wired to a dropdown.
//       items: [{ label, onSelect, variant? }]  (variant: 'danger')
//       items may also be a function returning that array (evaluated on open).
//   RowMenu.confirmDialog({ title, message, confirmLabel?, cancelLabel?,
//                           danger?, onConfirm })  -> modal; onConfirm may be async.
//
// The dropdown is appended to <body> with fixed positioning so it isn't clipped
// by the sidebar's / content's overflow, and closes on outside-click, Esc,
// scroll, or resize.
(function () {
  let openMenu = null;
  let openTrigger = null;

  function closeMenu() {
    if (!openMenu) return;
    openMenu.remove();
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onMenuKey, true);
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
    openMenu = null;
    openTrigger = null;
  }
  function onDocClick(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
  function onMenuKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } }

  // Keep the menu anchored to its trigger on scroll/resize rather than closing,
  // so a stray layout event can't dismiss it out from under the user.
  function reposition() {
    if (!openMenu || !openTrigger) return;
    const r = openTrigger.getBoundingClientRect();
    let left = Math.max(8, r.right - openMenu.offsetWidth);
    left = Math.min(left, window.innerWidth - openMenu.offsetWidth - 8);
    let top = r.bottom + 4;
    if (top + openMenu.offsetHeight > window.innerHeight - 8) top = r.top - openMenu.offsetHeight - 4;
    openMenu.style.left = `${left}px`;
    openMenu.style.top = `${top}px`;
  }

  function openDropdown(triggerEl, items) {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'row-menu';
    items.forEach((it) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'row-menu-item' + (it.variant === 'danger' ? ' danger' : '');
      b.textContent = it.label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenu();
        it.onSelect();
      });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);

    openMenu = menu;
    openTrigger = triggerEl;
    reposition();

    // Defer so this same click doesn't immediately close it.
    setTimeout(() => {
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onMenuKey, true);
      window.addEventListener('resize', reposition);
      window.addEventListener('scroll', reposition, true);
    }, 0);
    const first = menu.querySelector('.row-menu-item');
    if (first) first.focus();
  }

  function createRowMenu(items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row-menu-trigger';
    btn.setAttribute('aria-label', 'Row actions');
    btn.title = 'Actions';
    btn.textContent = '⋯';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (openMenu) { closeMenu(); return; }
      openDropdown(btn, typeof items === 'function' ? items() : items);
    });
    return btn;
  }

  function confirmDialog({ title, message, confirmLabel = 'Remove', cancelLabel = 'Cancel', danger = true, onConfirm }) {
    closeMenu();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-title" id="modal-title"></div>
        <div class="modal-body"></div>
        <div class="modal-actions">
          <button type="button" class="btn-secondary modal-cancel"></button>
          <button type="button" class="modal-confirm ${danger ? 'btn-danger' : 'btn-primary'}"></button>
        </div>
      </div>`;
    overlay.querySelector('.modal-title').textContent = title;
    overlay.querySelector('.modal-body').textContent = message;
    const cancelBtn = overlay.querySelector('.modal-cancel');
    const confirmBtn = overlay.querySelector('.modal-confirm');
    cancelBtn.textContent = cancelLabel;
    confirmBtn.textContent = confirmLabel;

    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    }
    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      try {
        await onConfirm();
        close();
      } catch (err) {
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
      }
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    confirmBtn.focus();
  }

  window.RowMenu = { createRowMenu, confirmDialog, closeMenu };
})();
