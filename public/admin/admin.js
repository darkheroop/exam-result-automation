/**
 * ABES Examination System - Enterprise Administrator Portal Engine
 * File: public/admin/admin.js
 * 
 * 100% Real API Driven - Communicates directly with Neon PostgreSQL backend.
 */

(function () {
  'use strict';

  // =========================================================================
  // Global Admin Application State
  // =========================================================================
  const state = {
    currentUser: { username: 'inexpert_trifler', role: 'Super Administrator' },
    activeTab: 'overview',
    students: [],
    pagination: {
      page: 1,
      limit: 10,
      total: 0,
      totalPages: 1
    },
    filters: {
      search: '',
      section: '',
      credential: '',
      sort: 'updated_desc'
    },
    sections: [],
    stats: {
      totalStudents: 0,
      totalSections: 0,
      withUsernames: 0,
      withoutUsernames: 0,
      withPasswords: 0,
      withoutPasswords: 0,
      sectionBreakdown: [],
      recentlyAdded: [],
      recentlyUpdated: []
    },
    pendingUpload: null,
    searchDebounceTimer: null,
    universalSearchFilter: 'all',
    deleteTargetId: null
  };

  // =========================================================================
  // Toast Notification System
  // =========================================================================
  function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'alert');

    let iconSvg = '';
    let titleText = 'Notice';

    if (type === 'success') {
      titleText = 'Success';
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
    } else if (type === 'error') {
      titleText = 'Error';
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
    } else if (type === 'warning') {
      titleText = 'Warning';
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
    } else {
      titleText = 'Information';
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
    }

    toast.innerHTML = `
      <div class="toast-icon">${iconSvg}</div>
      <div class="toast-content">
        <div class="toast-title">${titleText}</div>
        <div class="toast-message">${escapeHtml(message)}</div>
      </div>
      <button type="button" class="toast-close" aria-label="Dismiss toast">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    `;

    const closeBtn = toast.querySelector('.toast-close');
    if (closeBtn) closeBtn.addEventListener('click', () => removeToast(toast));

    container.appendChild(toast);

    const timer = setTimeout(() => {
      removeToast(toast);
    }, duration);

    function removeToast(t) {
      clearTimeout(timer);
      t.classList.add('removing');
      setTimeout(() => {
        if (t.parentElement) t.parentElement.removeChild(t);
      }, 200);
    }
  }

  // =========================================================================
  // Authenticated API Fetch Helper
  // =========================================================================
  async function apiFetch(endpoint, options = {}) {
    const token = localStorage.getItem('admin_token');
    const headers = {
      'Accept': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(options.headers || {})
    };

    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    try {
      const response = await fetch(endpoint, {
        ...options,
        headers
      });

      if (response.status === 401 || response.status === 403) {
        localStorage.removeItem('admin_token');
        localStorage.removeItem('admin_user');
        window.location.href = '/admin/login';
        return null;
      }

      const data = await response.json();
      return { ok: response.ok, status: response.status, data };
    } catch (err) {
      console.error(`[Admin API Error] ${endpoint}:`, err);
      return { ok: false, status: 0, error: err.message };
    }
  }

  // =========================================================================
  // Authentication & Session Guard
  // =========================================================================
  async function checkAuthSession() {
    const token = localStorage.getItem('admin_token');
    if (!token) {
      window.location.href = '/admin/login';
      return false;
    }

    const res = await apiFetch('/api/admin/me');
    if (res && res.ok && res.data && res.data.user) {
      state.currentUser = res.data.user;
      updateAdminDisplay();
      return true;
    }

    // Invalid session token
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
    window.location.href = '/admin/login';
    return false;
  }

  function updateAdminDisplay() {
    const username = state.currentUser.username || 'inexpert_trifler';
    const headerEl = document.getElementById('admin-header-username');
    const overviewEl = document.getElementById('overview-username');
    const avatarEl = document.getElementById('admin-avatar');

    if (headerEl) headerEl.textContent = username;
    if (overviewEl) overviewEl.textContent = username;
    if (avatarEl) {
      const initials = username.slice(0, 2).toUpperCase();
      avatarEl.textContent = initials || 'IT';
    }
  }

  async function handleLogout() {
    await apiFetch('/api/admin/logout', { method: 'POST' });
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
    showToast('Signed out of Administrator Console.', 'info');
    setTimeout(() => {
      window.location.href = '/admin/login';
    }, 300);
  }

  // =========================================================================
  // Tab Routing & Navigation
  // =========================================================================
  function initRouting() {
    window.addEventListener('hashchange', () => {
      const hash = window.location.hash.replace('#', '') || 'overview';
      switchTab(hash, false);
    });

    document.querySelectorAll('.nav-link[data-tab]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const tab = link.getAttribute('data-tab');
        switchTab(tab, true);
      });
    });

    document.querySelectorAll('a[href^="#"]').forEach(a => {
      if (a.classList.contains('nav-link')) return;
      a.addEventListener('click', (e) => {
        const target = a.getAttribute('href').replace('#', '');
        if (['overview', 'students', 'upload', 'search'].includes(target)) {
          e.preventDefault();
          switchTab(target, true);
        }
      });
    });

    const initialHash = window.location.hash.replace('#', '') || 'overview';
    switchTab(initialHash, false);
  }

  function switchTab(tabId, updateHash = true) {
    const validTabs = ['overview', 'students', 'upload', 'search'];
    if (!validTabs.includes(tabId)) tabId = 'overview';

    state.activeTab = tabId;

    if (updateHash) {
      window.location.hash = '#' + tabId;
    }

    document.querySelectorAll('.nav-link').forEach(link => {
      if (link.getAttribute('data-tab') === tabId) {
        link.classList.add('active');
      } else {
        link.classList.remove('active');
      }
    });

    document.querySelectorAll('.tab-view').forEach(view => {
      if (view.id === `view-${tabId}`) {
        view.classList.add('active');
      } else {
        view.classList.remove('active');
      }
    });

    const breadcrumb = document.getElementById('breadcrumb-current-tab');
    if (breadcrumb) {
      const titles = {
        overview: 'Dashboard Overview',
        students: 'Student Management',
        upload: 'Excel Upload & Import',
        search: 'Universal Search'
      };
      breadcrumb.textContent = titles[tabId] || 'Dashboard';
    }

    if (tabId === 'overview') {
      loadDashboardStats();
    } else if (tabId === 'students') {
      loadStudents();
    } else if (tabId === 'search') {
      const universalInput = document.getElementById('universal-search-input');
      if (universalInput) universalInput.focus();
    }

    closeMobileSidebar();
  }

  // =========================================================================
  // VIEW 1: Dashboard Overview & Statistics
  // =========================================================================
  async function loadDashboardStats() {
    const res = await apiFetch('/api/admin/stats');
    if (res && res.ok && res.data) {
      const stats = res.data.stats || res.data;
      renderDashboardStats(stats);
    } else {
      renderDashboardStats({
        totalStudents: 0,
        totalSections: 0,
        studentsWithUsername: 0,
        studentsWithoutUsername: 0,
        studentsWithPassword: 0,
        studentsWithoutPassword: 0,
        sectionBreakdown: [],
        recentlyAdded: [],
        recentlyUpdated: []
      });
    }
  }

  function renderDashboardStats(data) {
    state.stats = { ...state.stats, ...data };

    const setText = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = Number(val || 0).toLocaleString();
    };

    setText('stat-total-students', data.totalStudents || 0);
    setText('stat-total-sections', data.totalSections || 0);
    setText('stat-with-usernames', data.studentsWithUsername || 0);
    setText('stat-without-usernames', data.studentsWithoutUsername || 0);
    setText('stat-with-passwords', data.studentsWithPassword || 0);
    setText('stat-without-passwords', data.studentsWithoutPassword || 0);

    // Section Breakdown Pills
    const sectionContainer = document.getElementById('overview-section-chips');
    if (sectionContainer) {
      const breakdown = data.sectionBreakdown || [];
      if (breakdown.length === 0) {
        sectionContainer.innerHTML = '<span class="text-muted" style="font-size: 0.85rem;">No sections recorded yet.</span>';
      } else {
        sectionContainer.innerHTML = breakdown.map(item => `
          <button type="button" class="section-chip" data-section="${escapeHtml(item.section)}">
            <span class="section-chip-name">${escapeHtml(item.section)}</span>
            <span class="section-chip-count">${Number(item.count || 0).toLocaleString()}</span>
          </button>
        `).join('');

        sectionContainer.querySelectorAll('.section-chip').forEach(btn => {
          btn.addEventListener('click', () => {
            const sec = btn.getAttribute('data-section');
            state.filters.section = sec;
            const filterEl = document.getElementById('student-section-filter');
            if (filterEl) filterEl.value = sec;
            switchTab('students');
          });
        });
      }
    }

    // Recently Added Students
    const recentAddedTbody = document.getElementById('recent-added-tbody');
    if (recentAddedTbody) {
      const added = data.recentlyAdded || [];
      if (added.length === 0) {
        recentAddedTbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted" style="padding: 1.5rem;">No recently added students.</td></tr>`;
      } else {
        recentAddedTbody.innerHTML = added.map(s => `
          <tr>
            <td>
              <div class="user-cell">
                <div class="user-avatar-sm">${escapeHtml((s.name || 'S').slice(0, 2).toUpperCase())}</div>
                <div>
                  <div class="user-name">${escapeHtml(s.name || '—')}</div>
                  <div class="user-sub">${escapeHtml(s.admission_number || s.admissionNumber || '—')}</div>
                </div>
              </div>
            </td>
            <td><span class="badge badge-section">${escapeHtml(s.section || 'Unassigned')}</span></td>
            <td>
              ${s.username ? `<span class="badge badge-success">Configured</span>` : `<span class="badge badge-muted">Pending</span>`}
            </td>
            <td class="text-muted" style="font-size: 0.8rem;">${formatDate(s.created_at || s.createdAt)}</td>
          </tr>
        `).join('');
      }
    }

    // Recently Updated Students
    const recentUpdatedTbody = document.getElementById('recent-updated-tbody');
    if (recentUpdatedTbody) {
      const updated = data.recentlyUpdated || [];
      if (updated.length === 0) {
        recentUpdatedTbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted" style="padding: 1.5rem;">No recently updated students.</td></tr>`;
      } else {
        recentUpdatedTbody.innerHTML = updated.map(s => `
          <tr>
            <td>
              <div class="user-cell">
                <div class="user-avatar-sm">${escapeHtml((s.name || 'S').slice(0, 2).toUpperCase())}</div>
                <div>
                  <div class="user-name">${escapeHtml(s.name || '—')}</div>
                  <div class="user-sub">${escapeHtml(s.admission_number || s.admissionNumber || '—')}</div>
                </div>
              </div>
            </td>
            <td><span class="badge badge-section">${escapeHtml(s.section || 'Unassigned')}</span></td>
            <td>
              ${s.username && s.password ? `<span class="badge badge-success">Full</span>` : (s.username ? `<span class="badge badge-info">Username</span>` : `<span class="badge badge-muted">Pending</span>`)}
            </td>
            <td class="text-muted" style="font-size: 0.8rem;">${formatDate(s.updated_at || s.updatedAt)}</td>
          </tr>
        `).join('');
      }
    }
  }

  // =========================================================================
  // VIEW 2: Student Management Directory
  // =========================================================================
  async function loadStudents() {
    const { page, limit } = state.pagination;
    const { search, section, sort } = state.filters;

    const queryParams = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      search: search || '',
      section: section || '',
      sort: sort || 'updated_desc'
    });

    const res = await apiFetch(`/api/admin/students?${queryParams.toString()}`);
    if (res && res.ok && res.data) {
      const data = res.data;
      state.students = data.students || [];
      state.pagination.total = data.pagination?.total || data.total || 0;
      state.pagination.page = data.pagination?.page || page;
      state.pagination.totalPages = data.pagination?.totalPages || Math.max(1, Math.ceil(state.pagination.total / limit));

      if (Array.isArray(data.sections) && data.sections.length > 0) {
        populateSectionDropdown(data.sections);
      } else {
        const distinctSecs = Array.from(new Set(state.students.map(s => s.section).filter(Boolean))).sort();
        if (distinctSecs.length > 0) populateSectionDropdown(distinctSecs);
      }
    } else {
      state.students = [];
      state.pagination.total = 0;
      state.pagination.totalPages = 1;
    }

    renderStudentsTable();
  }

  function populateSectionDropdown(sectionsList) {
    const select = document.getElementById('student-section-filter');
    if (!select) return;

    const currentVal = state.filters.section || '';
    const cleanList = Array.from(new Set(sectionsList.filter(Boolean))).sort();

    select.innerHTML = '<option value="">All Sections</option>' + cleanList.map(s => `
      <option value="${escapeHtml(s)}" ${s === currentVal ? 'selected' : ''}>${escapeHtml(s)}</option>
    `).join('');
  }

  function renderStudentsTable() {
    const tbody = document.getElementById('students-tbody');
    const emptyState = document.getElementById('students-empty-state');
    const tableContainer = document.getElementById('students-table-container');
    const paginationContainer = document.getElementById('students-pagination');

    if (!tbody) return;

    const students = state.students;

    if (!students || students.length === 0) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.style.display = 'block';
      if (tableContainer) tableContainer.style.display = 'none';
      if (paginationContainer) paginationContainer.style.display = 'none';
      updatePaginationText(0, 0, 0);
      return;
    }

    if (emptyState) emptyState.style.display = 'none';
    if (tableContainer) tableContainer.style.display = 'block';
    if (paginationContainer) paginationContainer.style.display = 'flex';

    tbody.innerHTML = students.map(s => {
      const id = s.id;
      const name = s.name || '—';
      const adm = s.admission_number || s.admissionNumber || '—';
      const phone = s.phone_number || s.phone || '—';
      const username = s.username || '';
      const password = s.password || '';
      const section = s.section || '—';

      return `
        <tr data-student-id="${id}">
          <td>
            <div class="user-cell">
              <div class="user-avatar">${escapeHtml(name.slice(0, 2).toUpperCase())}</div>
              <div class="user-name-cell">
                <span class="font-semibold text-slate-900">${escapeHtml(name)}</span>
              </div>
            </div>
          </td>
          <td>
            <span class="font-mono text-slate-800">${escapeHtml(adm)}</span>
          </td>
          <td>
            <span class="font-mono text-slate-600">${escapeHtml(phone)}</span>
          </td>
          <td>
            ${username ? `<span class="badge badge-username font-mono">${escapeHtml(username)}</span>` : `<span class="text-muted italic" style="font-size: 0.85rem;">Not set</span>`}
          </td>
          <td>
            ${password ? `
              <div class="password-cell font-mono">
                <span class="masked-pass" data-actual="${escapeHtml(password)}">••••••••</span>
                <button type="button" class="btn-eye-toggle" title="Toggle password visibility" aria-label="Toggle password visibility">
                  <svg class="eye-icon-show" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                  <svg class="eye-icon-hide" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: none;">
                    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/>
                    <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/>
                    <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/>
                    <line x1="2" y1="2" x2="22" y2="22"/>
                  </svg>
                </button>
              </div>
            ` : `<span class="text-muted italic" style="font-size: 0.85rem;">Not set</span>`}
          </td>
          <td>
            <span class="badge badge-section">${escapeHtml(section)}</span>
          </td>
          <td>
            <div class="action-btn-group">
              <button type="button" class="btn btn-secondary btn-sm btn-action-edit" data-id="${id}" title="Edit Student">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                <span>Edit</span>
              </button>
              <button type="button" class="btn btn-danger-outline btn-sm btn-action-delete" data-id="${id}" data-name="${escapeHtml(name)}" data-adm="${escapeHtml(adm)}" title="Delete Student">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    // Attach row action listeners
    tbody.querySelectorAll('.btn-eye-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const passCell = btn.closest('.password-cell');
        if (!passCell) return;
        const textSpan = passCell.querySelector('.masked-pass');
        const showIcon = btn.querySelector('.eye-icon-show');
        const hideIcon = btn.querySelector('.eye-icon-hide');
        const actual = textSpan.getAttribute('data-actual') || '';

        if (textSpan.textContent === '••••••••') {
          textSpan.textContent = actual;
          textSpan.style.color = 'var(--indigo-600)';
          if (showIcon) showIcon.style.display = 'none';
          if (hideIcon) hideIcon.style.display = 'inline-block';
        } else {
          textSpan.textContent = '••••••••';
          textSpan.style.color = '';
          if (showIcon) showIcon.style.display = 'inline-block';
          if (hideIcon) hideIcon.style.display = 'none';
        }
      });
    });

    tbody.querySelectorAll('.btn-action-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        openEditStudentModal(id);
      });
    });

    tbody.querySelectorAll('.btn-action-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const name = btn.getAttribute('data-name');
        const adm = btn.getAttribute('data-adm');
        openDeleteStudentModal(id, name, adm);
      });
    });

    // Update Pagination Display
    const { page, limit, total, totalPages } = state.pagination;
    const startRecord = (page - 1) * limit + 1;
    const endRecord = Math.min(page * limit, total);
    updatePaginationText(startRecord, endRecord, total);
    renderPaginationButtons(page, totalPages);
  }

  function updatePaginationText(start, end, total) {
    const textEl = document.getElementById('pagination-info-text');
    if (!textEl) return;
    if (total === 0) {
      textEl.textContent = 'Showing 0 students';
    } else {
      textEl.textContent = `Showing ${start.toLocaleString()} to ${end.toLocaleString()} of ${total.toLocaleString()} students`;
    }
  }

  function renderPaginationButtons(currentPage, totalPages) {
    const container = document.getElementById('pagination-pages-container');
    const prevBtn = document.getElementById('btn-pagination-prev');
    const nextBtn = document.getElementById('btn-pagination-next');

    if (!container) return;

    if (prevBtn) {
      prevBtn.disabled = currentPage <= 1;
      prevBtn.onclick = () => {
        if (state.pagination.page > 1) {
          state.pagination.page--;
          loadStudents();
        }
      };
    }

    if (nextBtn) {
      nextBtn.disabled = currentPage >= totalPages;
      nextBtn.onclick = () => {
        if (state.pagination.page < totalPages) {
          state.pagination.page++;
          loadStudents();
        }
      };
    }

    container.innerHTML = '';
    const maxButtons = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxButtons / 2));
    let endPage = Math.min(totalPages, startPage + maxButtons - 1);

    if (endPage - startPage + 1 < maxButtons) {
      startPage = Math.max(1, endPage - maxButtons + 1);
    }

    if (startPage > 1) {
      container.appendChild(createPageBtn(1, currentPage === 1));
      if (startPage > 2) {
        const ellipsis = document.createElement('span');
        ellipsis.className = 'pagination-ellipsis';
        ellipsis.textContent = '…';
        container.appendChild(ellipsis);
      }
    }

    for (let p = startPage; p <= endPage; p++) {
      container.appendChild(createPageBtn(p, p === currentPage));
    }

    if (endPage < totalPages) {
      if (endPage < totalPages - 1) {
        const ellipsis = document.createElement('span');
        ellipsis.className = 'pagination-ellipsis';
        ellipsis.textContent = '…';
        container.appendChild(ellipsis);
      }
      container.appendChild(createPageBtn(totalPages, currentPage === totalPages));
    }
  }

  function createPageBtn(pageNum, isActive) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn-page ${isActive ? 'active' : ''}`;
    btn.textContent = String(pageNum);
    if (!isActive) {
      btn.addEventListener('click', () => {
        state.pagination.page = pageNum;
        loadStudents();
      });
    }
    return btn;
  }

  // =========================================================================
  // Modals: Edit Student & Delete Student
  // =========================================================================
  function initModals() {
    // Backdrop click close
    document.querySelectorAll('.modal-backdrop').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          closeModal(modal.id);
        }
      });
    });

    // Close buttons
    document.querySelectorAll('[data-close-modal]').forEach(btn => {
      btn.addEventListener('click', () => {
        const modalId = btn.getAttribute('data-close-modal');
        closeModal(modalId);
      });
    });

    // Edit form submission
    const editForm = document.getElementById('form-edit-student');
    if (editForm) {
      editForm.addEventListener('submit', handleSaveStudentEdit);
    }

    // Delete confirm button
    const deleteBtn = document.getElementById('btn-confirm-delete-student');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', handleConfirmDeleteStudent);
    }

    const cancelDeleteBtn = document.getElementById('btn-cancel-delete-modal');
    if (cancelDeleteBtn) {
      cancelDeleteBtn.addEventListener('click', () => closeModal('modal-delete-student'));
    }
  }

  function openModal(modalId) {
    const m = document.getElementById(modalId);
    if (m) m.classList.add('open');
  }

  function closeModal(modalId) {
    const m = document.getElementById(modalId);
    if (m) m.classList.remove('open');
  }

  async function openEditStudentModal(id) {
    let student = state.students.find(s => String(s.id) === String(id));
    if (!student) {
      const res = await apiFetch(`/api/admin/students/${id}`);
      if (res && res.ok && res.data) {
        student = res.data.student || res.data;
      }
    }

    if (!student) {
      showToast('Student record could not be found.', 'error');
      return;
    }

    populateEditForm(student);
    openModal('modal-edit-student');
  }

  function populateEditForm(s) {
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val || '';
    };

    setVal('edit-student-id', s.id);
    setVal('edit-student-name', s.name);
    setVal('edit-student-adm', s.admission_number || s.admissionNumber);
    setVal('edit-student-phone', s.phone_number || s.phone);
    setVal('edit-student-section', s.section);
    setVal('edit-student-username', s.username);
    setVal('edit-student-password', s.password);
  }

  function closeEditStudentModal() {
    closeModal('modal-edit-student');
  }

  async function handleSaveStudentEdit(e) {
    e.preventDefault();
    const id = document.getElementById('edit-student-id').value;
    const name = document.getElementById('edit-student-name').value.trim();
    const admissionNumber = document.getElementById('edit-student-adm').value.trim();
    const phone = document.getElementById('edit-student-phone').value.trim();
    const section = document.getElementById('edit-student-section').value.trim();
    const username = document.getElementById('edit-student-username').value.trim();
    const password = document.getElementById('edit-student-password').value.trim();

    if (!name || !admissionNumber) {
      showToast('Name and Admission Number are required fields.', 'warning');
      return;
    }

    const saveBtn = document.getElementById('btn-save-edit-student');
    const saveSpinner = document.getElementById('btn-save-edit-spinner');
    const saveText = document.getElementById('btn-save-edit-text');

    if (saveBtn) saveBtn.disabled = true;
    if (saveSpinner) saveSpinner.style.display = 'inline-block';
    if (saveText) saveText.textContent = 'Saving...';

    const payload = {
      name,
      admission_number: admissionNumber,
      phone_number: phone,
      section,
      username,
      password
    };

    const res = await apiFetch(`/api/admin/students/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: payload
    });

    if (saveBtn) saveBtn.disabled = false;
    if (saveSpinner) saveSpinner.style.display = 'none';
    if (saveText) saveText.textContent = 'Save Changes';

    if (res && res.ok) {
      showToast(`Student record for ${name} updated successfully in Neon database.`, 'success');
      closeEditStudentModal();
      loadStudents();
      loadDashboardStats();
    } else {
      const msg = (res && res.data && (res.data.error?.message || res.data.message)) || 'Failed to update student.';
      showToast(msg, 'error');
    }
  }

  function openDeleteStudentModal(id, name, adm) {
    state.deleteTargetId = id;
    const nameEl = document.getElementById('delete-student-name');
    const admEl = document.getElementById('delete-student-adm');
    if (nameEl) nameEl.textContent = name;
    if (admEl) admEl.textContent = adm;
    openModal('modal-delete-student');
  }

  async function handleConfirmDeleteStudent() {
    const id = state.deleteTargetId;
    if (!id) return;

    const delBtn = document.getElementById('btn-confirm-delete-student');
    const delSpinner = document.getElementById('btn-delete-spinner');
    const delText = document.getElementById('btn-delete-text');

    if (delBtn) delBtn.disabled = true;
    if (delSpinner) delSpinner.style.display = 'inline-block';
    if (delText) delText.textContent = 'Deleting...';

    const res = await apiFetch(`/api/admin/students/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });

    if (delBtn) delBtn.disabled = false;
    if (delSpinner) delSpinner.style.display = 'none';
    if (delText) delText.textContent = 'Permanently Delete';

    if (res && res.ok) {
      showToast('Student record deleted from database.', 'success');
      closeModal('modal-delete-student');
      state.deleteTargetId = null;
      loadStudents();
      loadDashboardStats();
    } else {
      const msg = (res && res.data && (res.data.error?.message || res.data.message)) || 'Failed to delete student.';
      showToast(msg, 'error');
    }
  }

  // =========================================================================
  // VIEW 3: Excel Upload & Import Workflow
  // =========================================================================
  function initExcelUpload() {
    const dropzone = document.getElementById('excel-dropzone');
    const fileInput = document.getElementById('excel-file-input');
    const browseBtn = document.getElementById('btn-browse-file');

    if (browseBtn && fileInput) {
      browseBtn.addEventListener('click', () => fileInput.click());
    }

    if (dropzone && fileInput) {
      dropzone.addEventListener('click', (e) => {
        if (e.target !== browseBtn) fileInput.click();
      });

      ['dragenter', 'dragover'].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.add('drag-over');
        });
      });

      ['dragleave', 'drop'].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.remove('drag-over');
        });
      });

      dropzone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files && files.length > 0) {
          processSelectedExcelFile(files[0]);
        }
      });

      fileInput.addEventListener('change', () => {
        if (fileInput.files && fileInput.files.length > 0) {
          processSelectedExcelFile(fileInput.files[0]);
        }
      });
    }

    const cancelPreviewBtn = document.getElementById('btn-cancel-import');
    if (cancelPreviewBtn) {
      cancelPreviewBtn.addEventListener('click', resetImportPreview);
    }

    const confirmImportBtn = document.getElementById('btn-confirm-import');
    if (confirmImportBtn) {
      confirmImportBtn.addEventListener('click', handleConfirmImport);
    }
  }

  function setUploadProgress(percent, statusText) {
    const wrapper = document.getElementById('upload-progress-wrapper');
    const fill = document.getElementById('upload-progress-fill');
    const text = document.getElementById('upload-progress-text');
    const percentEl = document.getElementById('upload-progress-percent');

    if (!wrapper) return;

    if (percent > 0) {
      wrapper.style.display = 'block';
      if (fill) fill.style.width = `${percent}%`;
      if (text && statusText) text.textContent = statusText;
      if (percentEl) percentEl.textContent = `${percent}%`;
    } else {
      wrapper.style.display = 'none';
      if (fill) fill.style.width = '0%';
    }
  }

  /**
   * Universal client-side Excel parsing matching backend intelligence
   */
  function parseWorkbookClient(arrayBuffer, filename) {
    if (typeof XLSX === 'undefined') return null;

    try {
      const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true, raw: false });
      const sheetNames = wb.SheetNames || [];
      if (sheetNames.length === 0) return null;

      const validRecords = [];
      const missingAdmissionRecords = [];
      const duplicateWithinFile = [];
      const warnings = [];
      const sectionsFoundSet = new Set();
      const seenAdm = new Map();
      let totalRawRowsCount = 0;

      const cleanVal = (val) => {
        if (val === null || val === undefined) return '';
        let str = String(val).trim();
        if (/^\d+\.0+$/.test(str)) str = str.replace(/\.0+$/, '');
        return str;
      };

      const matchCol = (headerCell) => {
        if (!headerCell || typeof headerCell !== 'string') return null;
        const h = headerCell.toLowerCase().replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').replace(/[.:\-_]+$/, '').trim();
        if (!h) return null;
        if (/(?:^|\b)(?:admission|adm)(?:\s*(?:no|num|number))?(?:$|\b)/i.test(h) || /^(?:admission_no|adm_no|admission_number|enrollment(?:\s*(?:no|num|number))?)$/i.test(h)) return 'adm';
        if (/(?:student\s*name|candidate\s*name|name\s*student|name\s*of\s*student|full\s*name|^name$)/i.test(h)) return 'name';
        if (/(?:student\s*mob|student\s*mobile|mob\s*no|mobile\s*no|^mob$|mobile|phone|contact|cell|whatsapp)/i.test(h)) return 'phone';
        if (/^(?:sec|sec\.|section|branch|class|batch)$/i.test(h)) return 'section';
        if (/(?:roll\s*(?:no|num|number)|student\s*id|registration)/i.test(h) || /^(?:roll_no|reg_no)$/i.test(h)) return 'roll';
        if (/^(?:user\s*name|username|login\s*id|user\s*id|user)$/i.test(h)) return 'username';
        if (/^(?:password|pwd|pass)$/i.test(h)) return 'password';
        return null;
      };

      const detectSec = (cellText) => {
        if (!cellText || typeof cellText !== 'string') return null;
        const text = cellText.replace(/\s+/g, ' ').trim();
        const branchMatch = text.match(/(?:branch\s*&\s*section|branch|section)\s*[:\-]?\s*(?:b\.?tech\.?)?\s*(?:\([^)]*\))?\s*([a-z0-9\-_ ]+)/i);
        if (branchMatch && branchMatch[1]) {
          const s = branchMatch[1].trim().replace(/\s*-\s*/g, '-');
          if (s.length >= 2 && !/^(name|faculty|date|total|sheet|session)/i.test(s)) return s;
        }
        const secMatch = text.match(/^\s*(?:section|sec|class|batch)\s*[:\-]?\s*([a-z0-9\-_ ]+)/i);
        if (secMatch && secMatch[1]) return secMatch[1].trim().replace(/\s*-\s*/g, '-');
        return null;
      };

      for (const sName of sheetNames) {
        const sheet = wb.Sheets[sName];
        if (!sheet) continue;
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        if (!rows || rows.length === 0) continue;

        const cleanSheetName = sName.trim();
        let sheetDefaultSec = cleanSheetName;
        if (cleanSheetName && !/^(sheet\d+|total students\s*\d*)$/i.test(cleanSheetName)) {
          sectionsFoundSet.add(cleanSheetName);
        } else {
          sheetDefaultSec = 'Default';
        }

        let currentSec = sheetDefaultSec;
        let colMap = null;

        for (let rIdx = 0; rIdx < rows.length; rIdx++) {
          const row = rows[rIdx];
          if (!Array.isArray(row)) continue;
          const nonEmpties = row.map(cleanVal).filter(Boolean);
          if (nonEmpties.length === 0) continue;

          totalRawRowsCount++;

          for (const cell of nonEmpties.slice(0, 3)) {
            const dSec = detectSec(cell);
            if (dSec) {
              currentSec = dSec;
              sectionsFoundSet.add(currentSec);
              colMap = null;
              break;
            }
          }

          const tempMap = {};
          for (let c = 0; c < row.length; c++) {
            const role = matchCol(cleanVal(row[c]));
            if (role && tempMap[role] === undefined) tempMap[role] = c;
          }

          const effAdm = tempMap.adm !== undefined ? tempMap.adm : tempMap.roll;
          if (effAdm !== undefined && (tempMap.name !== undefined || tempMap.phone !== undefined)) {
            colMap = {
              adm: effAdm,
              name: tempMap.name !== undefined ? tempMap.name : -1,
              phone: tempMap.phone !== undefined ? tempMap.phone : -1,
              section: tempMap.section !== undefined ? tempMap.section : -1,
              username: tempMap.username !== undefined ? tempMap.username : -1,
              password: tempMap.password !== undefined ? tempMap.password : -1
            };
            continue;
          }

          if (!colMap) continue;

          let rawAdm = colMap.adm >= 0 ? cleanVal(row[colMap.adm]) : '';
          let rawName = colMap.name >= 0 ? cleanVal(row[colMap.name]) : '';
          let rawPhone = colMap.phone >= 0 ? cleanVal(row[colMap.phone]) : '';
          let rawSec = colMap.section >= 0 ? cleanVal(row[colMap.section]) : '';
          let rawUser = colMap.username >= 0 ? cleanVal(row[colMap.username]) : '';
          let rawPass = colMap.password >= 0 ? cleanVal(row[colMap.password]) : '';

          if (matchCol(rawName) === 'name' || matchCol(rawAdm) === 'adm') continue;
          if (/^(total|hod|s\.?\s*no|faculty|subject|regular|lecture|attendance|sign)/i.test(rawName) || /^(total|hod|s\.?\s*no)/i.test(rawAdm)) continue;

          if (!rawAdm) {
            for (const cell of row) {
              const s = cleanVal(cell);
              if (/^202\d[A-Z0-9]{5,}$/i.test(s) || /^(?:201|202|203)\d{7,14}$/.test(s)) {
                rawAdm = s;
                break;
              }
            }
          }

          if (!rawPhone) {
            for (const cell of row) {
              const s = cleanVal(cell);
              if (/^[6-9]\d{9}$/.test(s)) {
                rawPhone = s;
                break;
              }
            }
          }

          if (!rawName && rawAdm) {
            for (const cell of row) {
              const s = cleanVal(cell);
              if (s !== rawAdm && s !== rawPhone && /^[a-zA-Z\s.]{3,50}$/.test(s) && !/^(total|hod|s\.?\s*no|branch|sec|regular|group|absent|present)/i.test(s)) {
                rawName = s;
                break;
              }
            }
          }

          let recSec = rawSec;
          if (!recSec || /^[a-z]\d+$/i.test(recSec)) {
            recSec = currentSec || sheetDefaultSec || 'Default';
          }
          sectionsFoundSet.add(recSec);

          if (!rawAdm) {
            if (rawName || rawPhone) {
              missingAdmissionRecords.push({
                sheet: sName,
                row: rIdx + 1,
                name: rawName,
                phone_number: rawPhone,
                section: recSec
              });
            }
            continue;
          }

          if (seenAdm.has(rawAdm)) {
            const prev = seenAdm.get(rawAdm);
            duplicateWithinFile.push({
              admission_number: rawAdm,
              name: rawName,
              section: recSec,
              row: rIdx + 1,
              prevRow: prev.row
            });
          } else {
            seenAdm.set(rawAdm, { row: rIdx + 1, sheet: sName, name: rawName });
          }

          validRecords.push({
            name: rawName || 'STUDENT',
            admission_number: rawAdm,
            phone_number: rawPhone,
            section: recSec,
            username: rawUser,
            password: rawPass
          });
        }
      }

      return {
        filename,
        sectionsFound: Array.from(sectionsFoundSet).filter(Boolean),
        totalRecords: totalRawRowsCount,
        validRecords,
        missingAdmissionRecords,
        duplicateWithinFile,
        warnings,
        sample: validRecords.slice(0, 25)
      };
    } catch (e) {
      console.warn('Client workbook parsing notice:', e.message);
      return null;
    }
  }

  async function processSelectedExcelFile(file) {
    const validExtensions = ['.xlsx', '.xlxs', '.xls', '.xlsm', '.xlsb', '.csv'];
    const fileName = (file.name || '').toLowerCase();
    const hasValidExt = validExtensions.some(ext => fileName.endsWith(ext));
    const mime = (file.type || '').toLowerCase();
    const isExcelMime = mime.includes('sheet') || mime.includes('excel') || mime.includes('csv');

    if (!hasValidExt && !isExcelMime) {
      showToast('Invalid file format. Please upload an Excel workbook (.xlsx, .xlxs, .xls).', 'error');
      return;
    }

    setUploadProgress(20, 'Reading file contents...');

    // 1. Read file as ArrayBuffer & Base64
    let arrayBuffer = null;
    let base64String = null;
    try {
      arrayBuffer = await file.arrayBuffer();
      const reader = new FileReader();
      base64String = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    } catch (readErr) {
      console.warn('FileReader error:', readErr);
    }

    // 2. Perform instant client-side parsing if SheetJS is available
    let clientParsed = null;
    if (arrayBuffer) {
      setUploadProgress(40, 'Parsing student records across all sections...');
      clientParsed = parseWorkbookClient(arrayBuffer, file.name);
    }

    if (clientParsed && clientParsed.validRecords.length > 0) {
      // Store local parsed records immediately so UI is responsive and preview is ready!
      state.pendingUpload = {
        fileName: file.name,
        previewToken: null,
        records: clientParsed.validRecords,
        summary: {
          filename: file.name,
          sectionsFound: clientParsed.sectionsFound,
          totalRecords: clientParsed.totalRecords,
          validRecordsCount: clientParsed.validRecords.length,
          missingAdmissionCount: clientParsed.missingAdmissionRecords.length,
          duplicateWithinFileCount: clientParsed.duplicateWithinFile.length,
          warnings: clientParsed.warnings
        },
        sample: clientParsed.sample,
        ...clientParsed
      };
      renderImportPreview(state.pendingUpload, file.name);
    }

    // 3. Send to server for server preview verification and previewToken issuance
    setUploadProgress(70, 'Syncing with server...');
    const token = localStorage.getItem('admin_token');

    try {
      let response;
      if (base64String) {
        // Send as clean Base64 JSON payload (no multipart timeouts or Vercel socket drops!)
        response = await fetch('/api/admin/upload-preview', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body: JSON.stringify({
            filename: file.name,
            fileBase64: base64String,
            records: clientParsed ? clientParsed.validRecords : undefined
          })
        });
      } else {
        // Fallback to FormData
        const formData = new FormData();
        formData.append('file', file);
        response = await fetch('/api/admin/upload-preview', {
          method: 'POST',
          headers: {
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body: formData
        });
      }

      setUploadProgress(100, 'Processing complete.');
      setTimeout(() => setUploadProgress(0), 400);

      const resData = await response.json();

      if (response.ok && resData.success) {
        if (!state.pendingUpload || !state.pendingUpload.records || state.pendingUpload.records.length === 0) {
          state.pendingUpload = {
            fileName: file.name,
            previewToken: resData.previewToken,
            records: clientParsed ? clientParsed.validRecords : undefined,
            ...resData
          };
          renderImportPreview(resData, file.name);
        } else {
          state.pendingUpload.previewToken = resData.previewToken;
        }
      } else {
        // If server had a non-critical warning but client parsed successfully, keep client preview
        if (!state.pendingUpload || !state.pendingUpload.records || state.pendingUpload.records.length === 0) {
          const errorMsg = (resData && (resData.error?.message || resData.message)) || 'Failed to parse Excel workbook.';
          showToast(errorMsg, 'error');
          resetImportPreview();
        }
      }
    } catch (err) {
      setUploadProgress(0);
      // If client already parsed and rendered preview, network failure on preview is non-fatal!
      if (state.pendingUpload && state.pendingUpload.records && state.pendingUpload.records.length > 0) {
        console.warn('Server preview network notice, retaining client-parsed preview:', err.message);
      } else {
        showToast(`Upload failed: ${err.message}`, 'error');
        resetImportPreview();
      }
    }
  }

  function renderImportPreview(data, fileName) {
    const previewBox = document.getElementById('import-preview-box');
    const resultCard = document.getElementById('import-result-card');
    if (resultCard) resultCard.style.display = 'none';
    if (!previewBox) return;

    previewBox.style.display = 'block';

    const summary = data.summary || {};
    const setText = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = Number(val || 0).toLocaleString();
    };

    setText('preview-total-records', summary.totalRecords || data.totalRecords || 0);
    setText('preview-valid-records', summary.validRecordsCount || data.validRecords || 0);
    setText('preview-missing-adm', summary.missingAdmissionCount || data.missingAdmissionNumbers || 0);
    setText('preview-duplicate-records', summary.duplicateWithinFileCount || data.duplicateRecords || 0);

    // Detected Sections
    const sectionsEl = document.getElementById('preview-detected-sections');
    if (sectionsEl) {
      const sections = summary.sectionsFound || data.detectedSections || [];
      if (sections.length === 0) {
        sectionsEl.innerHTML = '<span class="text-muted" style="font-size: 0.8rem;">General Section</span>';
      } else {
        sectionsEl.innerHTML = sections.map(sec => `
          <span class="badge badge-section" style="font-size: 0.75rem;">${escapeHtml(sec)}</span>
        `).join(' ');
      }
    }

    // Warnings Box
    const warningsEl = document.getElementById('preview-warnings-container');
    const warnings = summary.warnings || data.warnings || [];
    if (warningsEl) {
      if (warnings.length > 0) {
        warningsEl.style.display = 'block';
        warningsEl.innerHTML = `
          <div class="alert alert-warning" style="margin-top: 0.75rem;">
            <strong>Import Notice:</strong>
            <ul style="margin: 0.25rem 0 0 1rem; padding: 0; font-size: 0.8rem;">
              ${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}
            </ul>
          </div>
        `;
      } else {
        warningsEl.style.display = 'none';
        warningsEl.innerHTML = '';
      }
    }

    // Preview Table (first 15 rows)
    const tbody = document.getElementById('preview-sample-tbody');
    if (tbody) {
      const rows = data.sample || data.previewRows || [];
      if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted" style="padding: 1.5rem;">No valid preview records found.</td></tr>`;
      } else {
        tbody.innerHTML = rows.slice(0, 15).map((r, idx) => `
          <tr>
            <td>${idx + 1}</td>
            <td class="font-semibold">${escapeHtml(r.name || '—')}</td>
            <td class="font-mono">${escapeHtml(r.admission_number || r.admissionNumber || '—')}</td>
            <td class="font-mono">${escapeHtml(r.phone_number || r.phone || '—')}</td>
            <td><span class="badge badge-section">${escapeHtml(r.section || '—')}</span></td>
            <td><span class="badge badge-success">Valid</span></td>
          </tr>
        `).join('');
      }
    }

    previewBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function resetImportPreview() {
    state.pendingUpload = null;
    const previewBox = document.getElementById('import-preview-box');
    if (previewBox) previewBox.style.display = 'none';

    const fileInput = document.getElementById('excel-file-input');
    if (fileInput) fileInput.value = '';
  }

  async function handleConfirmImport() {
    if (!state.pendingUpload || (!state.pendingUpload.previewToken && (!state.pendingUpload.records || state.pendingUpload.records.length === 0))) {
      showToast('No pending import found. Please select an Excel file first.', 'warning');
      return;
    }

    const confirmBtn = document.getElementById('btn-confirm-import');
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.innerHTML = `<span class="spinner" style="margin-right: 0.5rem;"></span> Ingesting records...`;
    }

    const payload = {
      previewToken: state.pendingUpload.previewToken,
      records: state.pendingUpload.records // Stateless resilience across serverless lambdas!
    };

    const res = await apiFetch('/api/admin/upload-confirm', {
      method: 'POST',
      body: payload
    });

    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = `Confirm & Save Import`;
    }

    if (res && res.ok && res.data) {
      const summary = res.data.result || res.data.summary || {};
      displayImportSummary(summary);
      resetImportPreview();
      showToast(res.data.message || 'Excel workbook successfully imported into Neon PostgreSQL database.', 'success');
      loadStudents();
      loadDashboardStats();
    } else {
      const errorMsg = (res && res.data && (res.data.error?.message || res.data.message)) || 'Import failed. Please try again.';
      showToast(errorMsg, 'error');
    }
  }

  function displayImportSummary(summary) {
    const card = document.getElementById('import-result-card');
    if (!card) return;

    card.style.display = 'block';

    const setText = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = Number(val || 0).toLocaleString();
    };

    setText('summary-total-processed', summary.total || summary.totalRecords || 0);
    setText('summary-new-added', summary.added || 0);
    setText('summary-existing-updated', summary.updated || 0);
    setText('summary-duplicates-skipped', summary.duplicates || summary.skipped || 0);

    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // =========================================================================
  // VIEW 4: Universal Search Engine
  // =========================================================================
  function initUniversalSearch() {
    const searchInput = document.getElementById('universal-search-input');
    const clearBtn = document.getElementById('btn-clear-universal-search');

    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const val = searchInput.value.trim();
        if (clearBtn) clearBtn.style.display = val ? 'inline-flex' : 'none';

        clearTimeout(state.searchDebounceTimer);
        state.searchDebounceTimer = setTimeout(() => {
          executeUniversalSearch(val);
        }, 300);
      });
    }

    if (clearBtn && searchInput) {
      clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearBtn.style.display = 'none';
        executeUniversalSearch('');
        searchInput.focus();
      });
    }

    // Filter Chips
    document.querySelectorAll('.filter-chip-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-chip-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.universalSearchFilter = btn.getAttribute('data-filter') || 'all';
        if (searchInput && searchInput.value.trim()) {
          executeUniversalSearch(searchInput.value.trim());
        }
      });
    });
  }

  async function executeUniversalSearch(query) {
    const tbody = document.getElementById('universal-results-tbody');
    const countEl = document.getElementById('universal-match-count');
    const emptyEl = document.getElementById('universal-empty-state');
    const tableWrap = document.getElementById('universal-table-wrapper');

    if (!tbody) return;

    if (!query) {
      tbody.innerHTML = '';
      if (countEl) countEl.textContent = '0 records';
      if (emptyEl) emptyEl.style.display = 'block';
      if (tableWrap) tableWrap.style.display = 'none';
      return;
    }

    const res = await apiFetch(`/api/admin/students?search=${encodeURIComponent(query)}&limit=50`);
    const results = (res && res.ok && res.data && res.data.students) ? res.data.students : [];

    if (countEl) {
      countEl.textContent = `${results.length.toLocaleString()} matching records found`;
    }

    if (results.length === 0) {
      tbody.innerHTML = '';
      if (emptyEl) emptyEl.style.display = 'block';
      if (tableWrap) tableWrap.style.display = 'none';
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';
    if (tableWrap) tableWrap.style.display = 'block';

    tbody.innerHTML = results.map(s => {
      const id = s.id;
      const name = s.name || '';
      const adm = s.admission_number || s.admissionNumber || '';
      const phone = s.phone_number || s.phone || '';
      const username = s.username || '';
      const password = s.password || '';
      const section = s.section || '';

      return `
        <tr>
          <td>
            <div class="user-cell">
              <div class="user-avatar">${escapeHtml(name.slice(0, 2).toUpperCase())}</div>
              <div>
                <div class="user-name">${highlightMatch(name, query)}</div>
              </div>
            </div>
          </td>
          <td><span class="font-mono font-semibold">${highlightMatch(adm, query)}</span></td>
          <td><span class="font-mono text-slate-600">${highlightMatch(phone, query)}</span></td>
          <td>
            ${username ? `<span class="badge badge-username font-mono">${highlightMatch(username, query)}</span>` : `<span class="text-muted italic" style="font-size: 0.8rem;">Not set</span>`}
          </td>
          <td>
            ${password ? `<span class="font-mono" style="letter-spacing: 2px;">••••••••</span>` : `<span class="text-muted italic" style="font-size: 0.8rem;">Not set</span>`}
          </td>
          <td><span class="badge badge-section">${escapeHtml(section || '—')}</span></td>
          <td>
            <button type="button" class="btn btn-secondary btn-sm btn-search-edit" data-id="${id}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
              <span>Edit</span>
            </button>
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('.btn-search-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        openEditStudentModal(id);
      });
    });
  }

  function highlightMatch(text, query) {
    if (!text || !query) return escapeHtml(text || '—');
    const safeText = String(text);
    const safeQuery = escapeRegExp(query);
    const regex = new RegExp(`(${safeQuery})`, 'gi');
    return escapeHtml(safeText).replace(regex, '<mark class="search-highlight">$1</mark>');
  }

  function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // =========================================================================
  // Mobile Controls & Search Filters
  // =========================================================================
  function initMobileControls() {
    const toggleBtn = document.getElementById('btn-sidebar-toggle');
    const sidebar = document.getElementById('app-sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');

    if (toggleBtn && sidebar) {
      toggleBtn.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        if (backdrop) backdrop.classList.toggle('open');
      });
    }

    if (backdrop && sidebar) {
      backdrop.addEventListener('click', () => {
        closeMobileSidebar();
      });
    }

    const quickLogoutBtn = document.getElementById('btn-quick-logout');
    if (quickLogoutBtn) {
      quickLogoutBtn.addEventListener('click', handleLogout);
    }

    const sidebarLogoutBtn = document.getElementById('btn-sidebar-logout');
    if (sidebarLogoutBtn) {
      sidebarLogoutBtn.addEventListener('click', (e) => {
        e.preventDefault();
        handleLogout();
      });
    }

    // Student Management Filters
    const searchInput = document.getElementById('student-search-input');
    const clearSearchBtn = document.getElementById('btn-clear-student-search');

    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const val = searchInput.value.trim();
        state.filters.search = val;
        state.pagination.page = 1;
        if (clearSearchBtn) clearSearchBtn.style.display = val ? 'inline-flex' : 'none';

        clearTimeout(state.searchDebounceTimer);
        state.searchDebounceTimer = setTimeout(() => {
          loadStudents();
        }, 300);
      });
    }

    if (clearSearchBtn && searchInput) {
      clearSearchBtn.addEventListener('click', () => {
        searchInput.value = '';
        state.filters.search = '';
        state.pagination.page = 1;
        clearSearchBtn.style.display = 'none';
        loadStudents();
        searchInput.focus();
      });
    }

    const sectionFilter = document.getElementById('student-section-filter');
    if (sectionFilter) {
      sectionFilter.addEventListener('change', () => {
        state.filters.section = sectionFilter.value;
        state.pagination.page = 1;
        loadStudents();
      });
    }

    const sortSelect = document.getElementById('student-sort-select');
    if (sortSelect) {
      sortSelect.addEventListener('change', () => {
        state.filters.sort = sortSelect.value;
        loadStudents();
      });
    }

    const refreshBtn = document.getElementById('btn-refresh-students');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        showToast('Refreshing student data from database...', 'info', 1500);
        loadStudents();
        loadDashboardStats();
      });
    }
  }

  function closeMobileSidebar() {
    const sidebar = document.getElementById('app-sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (sidebar) sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');
  }

  function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(isoStr) {
    if (!isoStr) return '—';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return String(isoStr);
      return d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
    } catch {
      return String(isoStr);
    }
  }

  // =========================================================================
  // Application Entry Point
  // =========================================================================
  async function initApp() {
    const isAuthenticated = await checkAuthSession();
    if (!isAuthenticated) return;

    initRouting();
    initModals();
    initExcelUpload();
    initUniversalSearch();
    initMobileControls();

    // Initial Data Fetch from real Neon database
    loadDashboardStats();
    loadStudents();
  }

  // Kick off application on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }

})();
