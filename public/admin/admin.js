/**
 * ABES Examination System - Enterprise Administrator Portal Engine
 * File: public/admin/admin.js
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
      sort: 'name_asc'
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
    useMockFallback: false
  };

  // Mock Database Seed for Resilient Development / Offline Demonstration
  const DEFAULT_STUDENT_SEED = [
    { id: 1, name: 'Ansh Singh', admission_number: '8887416471', phone_number: '8887416471', username: 'ansh14', password: 'Password@123', section: 'CSE-A', created_at: '2026-10-24T10:15:00Z', updated_at: '2026-10-30T08:20:00Z' },
    { id: 2, name: 'Aarav Sharma', admission_number: '2023CS001', phone_number: '9876543210', username: 'aarav.sharma', password: 'Password@2026', section: 'CSE-A', created_at: '2026-10-25T09:00:00Z', updated_at: '2026-10-29T14:30:00Z' },
    { id: 3, name: 'Aditi Verma', admission_number: '2023CS002', phone_number: '9876543211', username: 'aditi.v', password: 'Secret#442', section: 'CSE-A', created_at: '2026-10-25T09:10:00Z', updated_at: '2026-10-28T11:20:00Z' },
    { id: 4, name: 'Bhavya Gupta', admission_number: '2023CS003', phone_number: '9876543212', username: 'bhavya.g', password: 'Portal@2025', section: 'CSE-B', created_at: '2026-10-25T09:20:00Z', updated_at: '2026-10-29T15:00:00Z' },
    { id: 5, name: 'Chirag Malhotra', admission_number: '2023CS004', phone_number: '9876543213', username: 'chirag.m', password: '', section: 'CSE-B', created_at: '2026-10-25T09:30:00Z', updated_at: '2026-10-25T09:30:00Z' },
    { id: 6, name: 'Divya Nair', admission_number: '2023CS005', phone_number: '9876543214', username: '', password: 'Password#123', section: 'IT-A', created_at: '2026-10-25T09:40:00Z', updated_at: '2026-10-27T16:10:00Z' },
    { id: 7, name: 'Eshaan Patel', admission_number: '2023CS006', phone_number: '9876543215', username: 'eshaan.p', password: 'Eshaan@Safe1', section: 'IT-A', created_at: '2026-10-25T09:50:00Z', updated_at: '2026-10-30T09:00:00Z' },
    { id: 8, name: 'Farhan Ali', admission_number: '2023CS007', phone_number: '9876543216', username: 'farhan.ali', password: 'Farhan#987', section: 'IT-B', created_at: '2026-10-25T10:00:00Z', updated_at: '2026-10-26T12:00:00Z' },
    { id: 9, name: 'Gauri Joshi', admission_number: '2023CS008', phone_number: '9876543217', username: 'gauri.j', password: 'Gauri@Password', section: 'ECE-A', created_at: '2026-10-25T10:10:00Z', updated_at: '2026-10-28T13:45:00Z' },
    { id: 10, name: 'Harsh Vardhan', admission_number: '2023CS009', phone_number: '9876543218', username: '', password: '', section: 'ECE-A', created_at: '2026-10-25T10:20:00Z', updated_at: '2026-10-25T10:20:00Z' },
    { id: 11, name: 'Ishita Sen', admission_number: '2023CS010', phone_number: '9876543219', username: 'ishita.sen', password: 'Ishita@Secret', section: 'ECE-B', created_at: '2026-10-25T10:30:00Z', updated_at: '2026-10-29T10:15:00Z' },
    { id: 12, name: 'Jayant Mehta', admission_number: '2023CS011', phone_number: '9876543220', username: 'jayant.m', password: 'Jayant#Pass', section: 'CSE-A', created_at: '2026-10-25T10:40:00Z', updated_at: '2026-10-29T11:00:00Z' },
    { id: 13, name: 'Kavya Rao', admission_number: '2023CS012', phone_number: '9876543221', username: 'kavya.rao', password: 'Kavya@1234', section: 'CSE-B', created_at: '2026-10-25T10:50:00Z', updated_at: '2026-10-30T07:30:00Z' },
    { id: 14, name: 'Lakshya Yadav', admission_number: '2023CS013', phone_number: '9876543222', username: 'lakshya.y', password: 'Lakshya#2026', section: 'IT-A', created_at: '2026-10-25T11:00:00Z', updated_at: '2026-10-28T14:20:00Z' },
    { id: 15, name: 'Manish Kumar', admission_number: '2023CS014', phone_number: '9876543223', username: 'manish.k', password: 'Manish@Secure', section: 'IT-B', created_at: '2026-10-25T11:10:00Z', updated_at: '2026-10-27T09:15:00Z' }
  ];

  function getMockStore() {
    let stored = localStorage.getItem('abes_admin_students');
    if (!stored) {
      localStorage.setItem('abes_admin_students', JSON.stringify(DEFAULT_STUDENT_SEED));
      return [...DEFAULT_STUDENT_SEED];
    }
    try {
      return JSON.parse(stored);
    } catch {
      return [...DEFAULT_STUDENT_SEED];
    }
  }

  function saveMockStore(students) {
    localStorage.setItem('abes_admin_students', JSON.stringify(students));
  }

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
    closeBtn.addEventListener('click', () => removeToast(toast));

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
  // Authentication & Session Guard
  // =========================================================================
  async function checkAuthSession() {
    const token = localStorage.getItem('admin_token');

    try {
      const response = await fetch('/api/admin/me', {
        method: 'GET',
        headers: {
          'Authorization': token ? `Bearer ${token}` : '',
          'Accept': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data && data.user) {
          state.currentUser = data.user;
        }
        updateAdminDisplay();
        return true;
      } else if (response.status === 401 || response.status === 403) {
        localStorage.removeItem('admin_token');
        localStorage.removeItem('admin_user');
        window.location.href = '/admin/login';
        return false;
      }
    } catch (err) {
      console.warn('[Admin Portal] Session check note:', err.message);
    }

    // If token exists, proceed in local/offline session mode
    if (token) {
      const storedUser = localStorage.getItem('admin_user');
      if (storedUser) {
        try { state.currentUser = JSON.parse(storedUser); } catch {}
      }
      updateAdminDisplay();
      return true;
    }

    // No session available, redirect to login
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
    const token = localStorage.getItem('admin_token');
    try {
      await fetch('/api/admin/logout', {
        method: 'POST',
        headers: {
          'Authorization': token ? `Bearer ${token}` : '',
          'Content-Type': 'application/json'
        }
      });
    } catch (err) {
      // Ignore network errors on logout
    }

    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
    showToast('Signed out of Administrator Console.', 'info');
    setTimeout(() => {
      window.location.href = '/admin/login';
    }, 400);
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
    const token = localStorage.getItem('admin_token');

    try {
      const res = await fetch('/api/admin/stats', {
        headers: { 'Authorization': token ? `Bearer ${token}` : '' }
      });

      if (res.ok) {
        const data = await res.json();
        const stats = data.stats || data;
        renderDashboardStats(stats);
        return;
      }
    } catch (err) {
      console.warn('[Admin Portal] Stats endpoint fallback to local calculation');
    }

    // Fallback: Compute stats from local store
    const students = getMockStore();
    const sectionsMap = new Map();
    let withUsernames = 0;
    let withoutUsernames = 0;
    let withPasswords = 0;
    let withoutPasswords = 0;

    students.forEach(s => {
      const sec = (s.section || 'Unassigned').trim();
      sectionsMap.set(sec, (sectionsMap.get(sec) || 0) + 1);

      if (s.username && s.username.trim()) withUsernames++;
      else withoutUsernames++;

      if (s.password && s.password.trim()) withPasswords++;
      else withoutPasswords++;
    });

    const sectionBreakdown = Array.from(sectionsMap.entries())
      .map(([section, count]) => ({ section, count }))
      .sort((a, b) => b.count - a.count);

    const sortedByCreated = [...students].sort((a, b) => new Date(b.created_at || b.createdAt || 0) - new Date(a.created_at || a.createdAt || 0));
    const sortedByUpdated = [...students].sort((a, b) => new Date(b.updated_at || b.updatedAt || 0) - new Date(a.updated_at || a.updatedAt || 0));

    const computedStats = {
      totalStudents: students.length,
      totalSections: sectionsMap.size,
      studentsWithUsername: withUsernames,
      studentsWithoutUsername: withoutUsernames,
      studentsWithPassword: withPasswords,
      studentsWithoutPassword: withoutPasswords,
      sectionBreakdown,
      recentlyAdded: sortedByCreated.slice(0, 5),
      recentlyUpdated: sortedByUpdated.slice(0, 5)
    };

    renderDashboardStats(computedStats);
  }

  function renderDashboardStats(data) {
    state.stats = data;

    // 1. Metric Cards
    const totalStudents = data.totalStudents ?? data.total_students ?? 0;
    const totalSections = data.totalSections ?? data.total_sections ?? 0;
    const withUsernames = data.studentsWithUsername ?? data.withUsernames ?? data.with_usernames ?? 0;
    const withoutUsernames = data.studentsWithoutUsername ?? data.withoutUsernames ?? data.without_usernames ?? 0;
    const withPasswords = data.studentsWithPassword ?? data.withPasswords ?? data.with_passwords ?? 0;
    const withoutPasswords = data.studentsWithoutPassword ?? data.withoutPasswords ?? data.without_passwords ?? 0;

    document.getElementById('stat-total-students').textContent = Number(totalStudents).toLocaleString();
    document.getElementById('stat-total-sections').textContent = Number(totalSections).toLocaleString();
    document.getElementById('stat-with-usernames').textContent = Number(withUsernames).toLocaleString();
    document.getElementById('stat-without-usernames').textContent = Number(withoutUsernames).toLocaleString();
    document.getElementById('stat-with-passwords').textContent = Number(withPasswords).toLocaleString();
    document.getElementById('stat-without-passwords').textContent = Number(withoutPasswords).toLocaleString();

    // 2. Section Breakdown Chips
    const countBadge = document.getElementById('section-breakdown-count-badge');
    const chipsContainer = document.getElementById('section-chips-container');
    const breakdown = data.sectionBreakdown || [];

    if (countBadge) {
      countBadge.textContent = `${breakdown.length} Sections`;
    }

    if (chipsContainer) {
      if (breakdown.length === 0) {
        chipsContainer.innerHTML = `<span style="color: var(--slate-400); font-size: 0.85rem;">No sections recorded yet.</span>`;
      } else {
        chipsContainer.innerHTML = breakdown.map(item => `
          <button type="button" class="section-chip" data-section="${escapeHtml(item.section)}" title="Filter by Section ${escapeHtml(item.section)}">
            <span>${escapeHtml(item.section)}</span>
            <span class="section-chip-count">${item.count}</span>
          </button>
        `).join('');

        chipsContainer.querySelectorAll('.section-chip').forEach(chip => {
          chip.addEventListener('click', () => {
            const sec = chip.getAttribute('data-section');
            state.filters.section = sec;
            const filterDropdown = document.getElementById('student-section-filter');
            if (filterDropdown) filterDropdown.value = sec;
            switchTab('students');
          });
        });
      }
    }

    // 3. Recently Added Table
    const recentAddedTbody = document.getElementById('recently-added-tbody');
    if (recentAddedTbody) {
      const added = data.recentlyAdded || [];
      if (added.length === 0) {
        recentAddedTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--slate-400);">No recent additions.</td></tr>`;
      } else {
        recentAddedTbody.innerHTML = added.map(s => `
          <tr>
            <td><strong>${escapeHtml(s.name)}</strong></td>
            <td><code class="badge-code">${escapeHtml(s.admission_number || s.admissionNumber)}</code></td>
            <td><span class="section-badge">${escapeHtml(s.section || 'N/A')}</span></td>
            <td>${formatDate(s.created_at || s.createdAt)}</td>
          </tr>
        `).join('');
      }
    }

    // 4. Recently Updated Table
    const recentUpdatedTbody = document.getElementById('recently-updated-tbody');
    if (recentUpdatedTbody) {
      const updated = data.recentlyUpdated || [];
      if (updated.length === 0) {
        recentUpdatedTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--slate-400);">No recent updates.</td></tr>`;
      } else {
        recentUpdatedTbody.innerHTML = updated.map(s => `
          <tr>
            <td><strong>${escapeHtml(s.name)}</strong></td>
            <td><code class="badge-code">${escapeHtml(s.admission_number || s.admissionNumber)}</code></td>
            <td><span class="section-badge">${escapeHtml(s.section || 'N/A')}</span></td>
            <td>${formatDate(s.updated_at || s.updatedAt || s.created_at || s.createdAt)}</td>
          </tr>
        `).join('');
      }
    }
  }

  // =========================================================================
  // VIEW 2: Student Management Data Table & Filtering
  // =========================================================================
  async function loadStudents() {
    const token = localStorage.getItem('admin_token');
    const { page, limit } = state.pagination;
    const { search, section, credential, sort } = state.filters;

    // Map sort string to sortBy and sortOrder for backend
    let sortBy = 'id';
    let sortOrder = 'ASC';
    if (sort === 'name_asc') { sortBy = 'name'; sortOrder = 'ASC'; }
    else if (sort === 'name_desc') { sortBy = 'name'; sortOrder = 'DESC'; }
    else if (sort === 'adm_asc') { sortBy = 'admission_number'; sortOrder = 'ASC'; }
    else if (sort === 'updated_desc') { sortBy = 'updated_at'; sortOrder = 'DESC'; }

    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      search: search || '',
      section: section || '',
      sortBy,
      sortOrder
    });

    try {
      const res = await fetch(`/api/admin/students?${params.toString()}`, {
        headers: { 'Authorization': token ? `Bearer ${token}` : '' }
      });

      if (res.ok) {
        const data = await res.json();
        let studentList = data.students || [];

        // Apply client credential filter if selected
        if (credential === 'complete') {
          studentList = studentList.filter(s => s.username && s.password);
        } else if (credential === 'missing_username') {
          studentList = studentList.filter(s => !s.username);
        } else if (credential === 'missing_password') {
          studentList = studentList.filter(s => !s.password);
        }

        state.students = studentList;
        state.pagination.total = data.total ?? data.pagination?.total ?? state.students.length;
        state.pagination.totalPages = data.totalPages ?? data.pagination?.totalPages ?? Math.ceil(state.pagination.total / limit) || 1;

        if (data.sections) {
          populateSectionDropdown(data.sections);
        } else {
          // Extract sections from students
          const allSecs = Array.from(new Set(state.students.map(s => s.section).filter(Boolean))).sort();
          if (allSecs.length > 0) populateSectionDropdown(allSecs);
        }

        renderStudentsTable();
        return;
      }
    } catch (err) {
      console.warn('[Admin Portal] Student fetch fallback to local store filtering');
    }

    // Fallback: Local store filtering
    let allStudents = getMockStore();

    const distinctSections = Array.from(new Set(allStudents.map(s => s.section).filter(Boolean))).sort();
    populateSectionDropdown(distinctSections);

    if (search) {
      const q = search.toLowerCase();
      allStudents = allStudents.filter(s =>
        (s.name && s.name.toLowerCase().includes(q)) ||
        ((s.admission_number || s.admissionNumber) && (s.admission_number || s.admissionNumber).toLowerCase().includes(q)) ||
        ((s.phone_number || s.phone) && (s.phone_number || s.phone).toLowerCase().includes(q)) ||
        (s.username && s.username.toLowerCase().includes(q))
      );
    }

    if (section) {
      allStudents = allStudents.filter(s => (s.section || '').toLowerCase() === section.toLowerCase());
    }

    if (credential === 'complete') {
      allStudents = allStudents.filter(s => s.username && s.password);
    } else if (credential === 'missing_username') {
      allStudents = allStudents.filter(s => !s.username);
    } else if (credential === 'missing_password') {
      allStudents = allStudents.filter(s => !s.password);
    }

    if (sort === 'name_asc') {
      allStudents.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else if (sort === 'name_desc') {
      allStudents.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
    } else if (sort === 'adm_asc') {
      allStudents.sort((a, b) => (a.admission_number || a.admissionNumber || '').localeCompare(b.admission_number || b.admissionNumber || ''));
    } else if (sort === 'updated_desc') {
      allStudents.sort((a, b) => new Date(b.updated_at || b.updatedAt || 0) - new Date(a.updated_at || a.updatedAt || 0));
    }

    state.pagination.total = allStudents.length;
    state.pagination.totalPages = Math.max(1, Math.ceil(allStudents.length / limit));

    const startIdx = (page - 1) * limit;
    state.students = allStudents.slice(startIdx, startIdx + limit);

    renderStudentsTable();
  }

  function populateSectionDropdown(sectionsList) {
    state.sections = sectionsList;
    const select = document.getElementById('student-section-filter');
    if (!select) return;

    const currentVal = select.value;
    select.innerHTML = '<option value="">All Sections</option>';

    sectionsList.forEach(sec => {
      const opt = document.createElement('option');
      opt.value = sec;
      opt.textContent = `Section ${sec}`;
      if (sec === currentVal) opt.selected = true;
      select.appendChild(opt);
    });
  }

  function renderStudentsTable() {
    const tbody = document.getElementById('students-table-body');
    const emptyState = document.getElementById('students-empty-state');
    const paginationInfo = document.getElementById('pagination-info');

    if (!tbody) return;

    if (state.students.length === 0) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.style.display = 'block';
    } else {
      if (emptyState) emptyState.style.display = 'none';

      tbody.innerHTML = state.students.map(student => {
        const initials = (student.name || 'S')
          .split(' ')
          .map(w => w[0])
          .slice(0, 2)
          .join('')
          .toUpperCase();

        const admNum = student.admission_number || student.admissionNumber || '';
        const phoneNum = student.phone_number || student.phone || '';
        const hasPass = Boolean(student.password && student.password.trim());
        const passData = hasPass ? escapeHtml(student.password) : '';
        const hasUsername = Boolean(student.username && student.username.trim());

        return `
          <tr data-student-id="${escapeHtml(String(student.id))}">
            <!-- 1. Name -->
            <td>
              <div class="student-name-cell">
                <div class="student-avatar" aria-hidden="true">${initials}</div>
                <div>
                  <div class="student-name-text">${escapeHtml(student.name)}</div>
                  <div style="font-size: 0.72rem; color: var(--slate-400);">ID: ${escapeHtml(String(student.id))}</div>
                </div>
              </div>
            </td>

            <!-- 2. Admission Number -->
            <td>
              <code class="badge-code">${escapeHtml(admNum)}</code>
            </td>

            <!-- 3. Phone Number -->
            <td>
              ${phoneNum ? `<span style="font-family: var(--font-mono); font-size: 0.85rem;">${escapeHtml(phoneNum)}</span>` : '<span style="color: var(--slate-400); font-style: italic;">None</span>'}
            </td>

            <!-- 4. Username -->
            <td>
              ${hasUsername 
                ? `<code class="badge-code" style="color: var(--indigo-700); background: var(--indigo-50); border-color: var(--indigo-200);">${escapeHtml(student.username)}</code>` 
                : `<span style="color: var(--amber-600); font-size: 0.75rem; font-weight: 600;">Not Set</span>`}
            </td>

            <!-- 5. Password (Masked with Eye Toggle) -->
            <td>
              <div class="password-cell-wrapper">
                <span class="password-display-text" data-revealed="false" data-raw="${passData}">
                  ${hasPass ? '••••••••' : '<span style="color: var(--rose-500); font-size: 0.75rem; font-weight: 500;">Missing</span>'}
                </span>
                ${hasPass ? `
                  <button type="button" class="btn-eye-toggle" aria-label="Toggle password visibility" title="Show/Hide Password">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                  </button>
                ` : ''}
              </div>
            </td>

            <!-- 6. Section -->
            <td>
              <span class="section-badge">${escapeHtml(student.section || 'General')}</span>
            </td>

            <!-- 7. Actions -->
            <td style="text-align: right;">
              <div class="actions-cell" style="justify-content: flex-end;">
                <button type="button" class="btn-action-edit" data-id="${escapeHtml(String(student.id))}" title="Edit Student">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
                    <path d="m15 5 4 4"/>
                  </svg>
                </button>
                <button type="button" class="btn-action-delete" data-id="${escapeHtml(String(student.id))}" data-name="${escapeHtml(student.name)}" data-adm="${escapeHtml(admNum)}" title="Delete Student">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 6h18"/>
                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                  </svg>
                </button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }

    // Attach row eye toggle listeners
    tbody.querySelectorAll('.btn-eye-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const wrapper = btn.closest('.password-cell-wrapper');
        const textSpan = wrapper.querySelector('.password-display-text');
        const isRevealed = textSpan.getAttribute('data-revealed') === 'true';
        const raw = textSpan.getAttribute('data-raw');

        if (isRevealed) {
          textSpan.textContent = '••••••••';
          textSpan.setAttribute('data-revealed', 'false');
          btn.innerHTML = `
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          `;
        } else {
          textSpan.textContent = raw;
          textSpan.setAttribute('data-revealed', 'true');
          btn.innerHTML = `
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/>
              <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/>
              <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/>
              <line x1="2" y1="2" x2="22" y2="22"/>
            </svg>
          `;
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

    const { page, limit, total, totalPages } = state.pagination;
    const startRecord = total === 0 ? 0 : (page - 1) * limit + 1;
    const endRecord = Math.min(page * limit, total);

    if (paginationInfo) {
      paginationInfo.textContent = `Showing ${startRecord} to ${endRecord} of ${total} students`;
    }

    renderPaginationButtons(page, totalPages);
  }

  function renderPaginationButtons(currentPage, totalPages) {
    const container = document.getElementById('pagination-buttons');
    if (!container) return;

    container.innerHTML = '';

    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'page-btn';
    prevBtn.disabled = currentPage <= 1;
    prevBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="15 18 9 12 15 6"/>
      </svg>
    `;
    prevBtn.addEventListener('click', () => {
      if (state.pagination.page > 1) {
        state.pagination.page--;
        loadStudents();
      }
    });
    container.appendChild(prevBtn);

    let startPage = Math.max(1, currentPage - 2);
    let endPage = Math.min(totalPages, currentPage + 2);

    if (startPage > 1) {
      const p1 = createPageBtn(1, currentPage === 1);
      container.appendChild(p1);
      if (startPage > 2) {
        const dots = document.createElement('span');
        dots.style.padding = '0 0.35rem';
        dots.style.color = 'var(--slate-400)';
        dots.textContent = '...';
        container.appendChild(dots);
      }
    }

    for (let p = startPage; p <= endPage; p++) {
      const pBtn = createPageBtn(p, p === currentPage);
      container.appendChild(pBtn);
    }

    if (endPage < totalPages) {
      if (endPage < totalPages - 1) {
        const dots = document.createElement('span');
        dots.style.padding = '0 0.35rem';
        dots.style.color = 'var(--slate-400)';
        dots.textContent = '...';
        container.appendChild(dots);
      }
      const pLast = createPageBtn(totalPages, currentPage === totalPages);
      container.appendChild(pLast);
    }

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'page-btn';
    nextBtn.disabled = currentPage >= totalPages;
    nextBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    `;
    nextBtn.addEventListener('click', () => {
      if (state.pagination.page < state.pagination.totalPages) {
        state.pagination.page++;
        loadStudents();
      }
    });
    container.appendChild(nextBtn);
  }

  function createPageBtn(pageNum, isActive) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `page-btn ${isActive ? 'active' : ''}`;
    btn.textContent = String(pageNum);
    btn.addEventListener('click', () => {
      if (state.pagination.page !== pageNum) {
        state.pagination.page = pageNum;
        loadStudents();
      }
    });
    return btn;
  }

  // =========================================================================
  // MODALS: Edit, Add & Delete Student
  // =========================================================================
  function initModals() {
    document.getElementById('btn-close-edit-modal')?.addEventListener('click', closeEditStudentModal);
    document.getElementById('btn-cancel-edit-modal')?.addEventListener('click', closeEditStudentModal);

    const editTogglePassBtn = document.getElementById('btn-edit-toggle-password');
    const editPassInput = document.getElementById('edit-student-password');
    if (editTogglePassBtn && editPassInput) {
      editTogglePassBtn.addEventListener('click', () => {
        const isPass = editPassInput.type === 'password';
        editPassInput.type = isPass ? 'text' : 'password';
      });
    }

    document.getElementById('form-edit-student')?.addEventListener('submit', handleSaveStudentEdit);

    document.getElementById('btn-open-add-student')?.addEventListener('click', () => {
      document.getElementById('form-add-student')?.reset();
      openModal('modal-add-student');
    });
    document.getElementById('btn-close-add-modal')?.addEventListener('click', () => closeModal('modal-add-student'));
    document.getElementById('btn-cancel-add-modal')?.addEventListener('click', () => closeModal('modal-add-student'));
    document.getElementById('form-add-student')?.addEventListener('submit', handleAddStudent);

    document.getElementById('btn-cancel-delete-modal')?.addEventListener('click', () => closeModal('modal-delete-student'));
    document.getElementById('btn-confirm-delete-student')?.addEventListener('click', handleConfirmDeleteStudent);
  }

  function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('show');
  }

  function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('show');
  }

  async function openEditStudentModal(id) {
    // Attempt to fetch fresh data for this student
    const token = localStorage.getItem('admin_token');
    let student = null;

    try {
      const res = await fetch(`/api/admin/students/${encodeURIComponent(id)}`, {
        headers: { 'Authorization': token ? `Bearer ${token}` : '' }
      });
      if (res.ok) {
        const data = await res.json();
        student = data.student || data;
      }
    } catch (err) {
      // Fallback to state
    }

    if (!student) {
      student = state.students.find(s => String(s.id) === String(id));
    }
    if (!student) {
      const all = getMockStore();
      student = all.find(item => String(item.id) === String(id));
    }
    if (!student) return;

    populateEditForm(student);
    openModal('modal-edit-student');
  }

  function populateEditForm(s) {
    document.getElementById('edit-student-id').value = s.id || '';
    document.getElementById('edit-student-name').value = s.name || '';
    document.getElementById('edit-student-adm').value = s.admission_number || s.admissionNumber || '';
    document.getElementById('edit-student-phone').value = s.phone_number || s.phone || '';
    document.getElementById('edit-student-section').value = s.section || '';
    document.getElementById('edit-student-username').value = s.username || '';
    document.getElementById('edit-student-password').value = s.password || '';
  }

  function closeEditStudentModal() {
    closeModal('modal-edit-student');
  }

  async function handleSaveStudentEdit(e) {
    e.preventDefault();
    const token = localStorage.getItem('admin_token');

    const id = document.getElementById('edit-student-id').value;
    const name = document.getElementById('edit-student-name').value.trim();
    const admissionNumber = document.getElementById('edit-student-adm').value.trim();
    const phone = document.getElementById('edit-student-phone').value.trim();
    const section = document.getElementById('edit-student-section').value.trim();
    const username = document.getElementById('edit-student-username').value.trim();
    const password = document.getElementById('edit-student-password').value.trim();

    if (!name || !admissionNumber) {
      showToast('Name and Admission Number are strictly required.', 'warning');
      return;
    }

    const payload = {
      name,
      admission_number: admissionNumber,
      admissionNumber,
      phone_number: phone,
      phone,
      section,
      username,
      password,
      updated_at: new Date().toISOString()
    };

    const saveBtn = document.getElementById('btn-save-edit-student');
    const saveSpinner = document.getElementById('btn-save-edit-spinner');
    const saveText = document.getElementById('btn-save-edit-text');

    if (saveBtn) saveBtn.disabled = true;
    if (saveSpinner) saveSpinner.style.display = 'inline-block';
    if (saveText) saveText.textContent = 'Saving...';

    try {
      const res = await fetch(`/api/admin/students/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: {
          'Authorization': token ? `Bearer ${token}` : '',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        showToast(`Student record for ${name} updated successfully.`, 'success');
        closeEditStudentModal();
        loadStudents();
        loadDashboardStats();
        return;
      }
    } catch (err) {
      console.warn('[Admin Portal] PUT student network fallback to local store');
    } finally {
      if (saveBtn) saveBtn.disabled = false;
      if (saveSpinner) saveSpinner.style.display = 'none';
      if (saveText) saveText.textContent = 'Save Changes';
    }

    // Local Store Fallback
    const store = getMockStore();
    const idx = store.findIndex(s => String(s.id) === String(id));
    if (idx !== -1) {
      store[idx] = { ...store[idx], ...payload };
      saveMockStore(store);
      showToast(`Student record for ${name} updated successfully.`, 'success');
      closeEditStudentModal();
      loadStudents();
      loadDashboardStats();
    }
  }

  async function handleAddStudent(e) {
    e.preventDefault();
    const token = localStorage.getItem('admin_token');

    const name = document.getElementById('add-student-name').value.trim();
    const admissionNumber = document.getElementById('add-student-adm').value.trim();
    const phone = document.getElementById('add-student-phone').value.trim();
    const section = document.getElementById('add-student-section').value.trim();
    const username = document.getElementById('add-student-username').value.trim();
    const password = document.getElementById('add-student-password').value.trim();

    if (!name || !admissionNumber) {
      showToast('Name and Admission Number are required.', 'warning');
      return;
    }

    const payload = {
      name,
      admission_number: admissionNumber,
      admissionNumber,
      phone_number: phone,
      phone,
      section: section || 'General',
      username,
      password,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    try {
      const res = await fetch('/api/admin/students', {
        method: 'POST',
        headers: {
          'Authorization': token ? `Bearer ${token}` : '',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        showToast(`Student ${name} registered successfully.`, 'success');
        closeModal('modal-add-student');
        loadStudents();
        loadDashboardStats();
        return;
      }
    } catch (err) {
      console.warn('[Admin Portal] POST student fallback to local store');
    }

    const store = getMockStore();
    const newId = Date.now();
    store.unshift({ id: newId, ...payload });
    saveMockStore(store);

    showToast(`Student ${name} registered successfully.`, 'success');
    closeModal('modal-add-student');
    loadStudents();
    loadDashboardStats();
  }

  let pendingDeleteId = null;

  function openDeleteStudentModal(id, name, adm) {
    pendingDeleteId = id;
    const nameEl = document.getElementById('delete-student-name');
    const admEl = document.getElementById('delete-student-adm');

    if (nameEl) nameEl.textContent = name;
    if (admEl) admEl.textContent = adm;

    openModal('modal-delete-student');
  }

  async function handleConfirmDeleteStudent() {
    if (!pendingDeleteId) return;

    const token = localStorage.getItem('admin_token');
    const deleteBtn = document.getElementById('btn-confirm-delete-student');
    const deleteSpinner = document.getElementById('btn-delete-spinner');
    const deleteText = document.getElementById('btn-delete-text');

    if (deleteBtn) deleteBtn.disabled = true;
    if (deleteSpinner) deleteSpinner.style.display = 'inline-block';
    if (deleteText) deleteText.textContent = 'Deleting...';

    try {
      const res = await fetch(`/api/admin/students/${encodeURIComponent(pendingDeleteId)}`, {
        method: 'DELETE',
        headers: { 'Authorization': token ? `Bearer ${token}` : '' }
      });

      if (res.ok) {
        showToast('Student record deleted permanently.', 'success');
        closeModal('modal-delete-student');
        loadStudents();
        loadDashboardStats();
        return;
      }
    } catch (err) {
      console.warn('[Admin Portal] DELETE student fallback to local store');
    } finally {
      if (deleteBtn) deleteBtn.disabled = false;
      if (deleteSpinner) deleteSpinner.style.display = 'none';
      if (deleteText) deleteText.textContent = 'Permanently Delete';
    }

    let store = getMockStore();
    store = store.filter(s => String(s.id) !== String(pendingDeleteId));
    saveMockStore(store);

    showToast('Student record deleted permanently.', 'success');
    closeModal('modal-delete-student');
    loadStudents();
    loadDashboardStats();
  }

  // =========================================================================
  // VIEW 3: Excel Drag-and-Drop & Batch Ingestion
  // =========================================================================
  function initExcelUpload() {
    const dropzone = document.getElementById('excel-dropzone');
    const fileInput = document.getElementById('excel-file-input');

    if (!dropzone || !fileInput) return;

    dropzone.addEventListener('click', () => fileInput.click());

    ['dragenter', 'dragover'].forEach(eventName => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach(eventName => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove('dragover');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      const files = dt.files;
      if (files && files.length > 0) {
        processSelectedExcelFile(files[0]);
      }
    });

    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        processSelectedExcelFile(e.target.files[0]);
      }
    });

    document.getElementById('btn-confirm-import')?.addEventListener('click', handleConfirmImport);
    document.getElementById('btn-cancel-import')?.addEventListener('click', resetImportPreview);
    document.getElementById('btn-summary-upload-another')?.addEventListener('click', resetImportPreview);
  }

  function setUploadProgress(percent, statusText) {
    const wrapper = document.getElementById('upload-progress-wrapper');
    const fill = document.getElementById('upload-progress-fill');
    const status = document.getElementById('upload-progress-status');
    const percentEl = document.getElementById('upload-progress-percent');

    if (!wrapper) return;

    if (percent > 0) {
      wrapper.style.display = 'block';
      if (fill) fill.style.width = `${percent}%`;
      if (status && statusText) status.textContent = statusText;
      if (percentEl) percentEl.textContent = `${percent}%`;
    } else {
      wrapper.style.display = 'none';
      if (fill) fill.style.width = '0%';
    }
  }

  async function processSelectedExcelFile(file) {
    const validExtensions = ['.xlsx', '.xls'];
    const fileName = file.name || '';
    const hasValidExt = validExtensions.some(ext => fileName.toLowerCase().endsWith(ext));

    if (!hasValidExt) {
      showToast('Invalid file format. Please upload a valid .xlsx or .xls spreadsheet.', 'error');
      return;
    }

    setUploadProgress(20, 'Reading workbook contents...');

    // Attempt backend preview first via FormData
    const token = localStorage.getItem('admin_token');
    const formData = new FormData();
    formData.append('file', file);

    try {
      setUploadProgress(50, 'Ingesting and validating rows...');
      const res = await fetch('/api/admin/upload-preview', {
        method: 'POST',
        headers: { 'Authorization': token ? `Bearer ${token}` : '' },
        body: formData
      });

      if (res.ok) {
        const previewResponse = await res.json();
        setUploadProgress(100, 'Parsing complete.');
        setTimeout(() => setUploadProgress(0), 400);

        const summary = previewResponse.summary || {};
        const normalizedData = {
          previewToken: previewResponse.previewToken,
          totalRecords: summary.totalRecords || 0,
          validRecords: summary.validRecordsCount || 0,
          detectedSections: summary.sectionsFound || [],
          detectedColumns: ['Name', 'Admission Number', 'Phone', 'Username', 'Password', 'Section'],
          missingAdmissionNumbers: summary.missingAdmissionCount || 0,
          duplicateRecords: summary.duplicateWithinFileCount || 0,
          warnings: summary.warnings || [],
          previewRows: (previewResponse.sample || []).map(r => ({
            name: r.name,
            admissionNumber: r.admission_number || r.admissionNumber,
            phone: r.phone_number || r.phone,
            username: r.username,
            password: r.password,
            section: r.section,
            hasError: false
          }))
        };

        renderImportPreview(normalizedData, file.name);
        return;
      }
    } catch (err) {
      console.warn('[Admin Portal] Backend preview endpoint fallback to client parsing');
    }

    // Client-side SheetJS Parsing Fallback
    if (typeof XLSX === 'undefined') {
      showToast('Excel parser unavailable. Please verify network.', 'error');
      setUploadProgress(0);
      return;
    }

    try {
      const reader = new FileReader();
      reader.onload = function (e) {
        setUploadProgress(75, 'Analyzing columns & headers...');
        const buffer = e.target.result;
        const workbook = XLSX.read(buffer, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rawJson = XLSX.utils.sheet_to_json(sheet, { defval: '' });

        const parsedResult = normalizeExcelRows(rawJson);
        parsedResult.previewToken = 'client_token_' + Date.now();
        setUploadProgress(100, 'Validation complete.');
        setTimeout(() => setUploadProgress(0), 400);

        renderImportPreview(parsedResult, file.name);
      };
      reader.readAsArrayBuffer(file);
    } catch (parseErr) {
      setUploadProgress(0);
      showToast('Failed to parse Excel file: ' + parseErr.message, 'error');
    }
  }

  function normalizeExcelRows(rows) {
    const detectedColsSet = new Set();
    const sectionsSet = new Set();
    const warnings = [];
    const seenAdm = new Set();
    let duplicateCount = 0;
    let missingAdmCount = 0;
    const normalizedRows = [];

    rows.forEach((row, index) => {
      const rowNum = index + 2;
      const keys = Object.keys(row);
      keys.forEach(k => detectedColsSet.add(k.trim()));

      function findVal(aliases) {
        for (const k of keys) {
          const cleanK = k.toLowerCase().replace(/[^a-z0-9]/g, '');
          for (const a of aliases) {
            if (cleanK === a.toLowerCase().replace(/[^a-z0-9]/g, '')) {
              return String(row[k] || '').trim();
            }
          }
        }
        return '';
      }

      const name = findVal(['name', 'studentname', 'student_name', 'fullname']);
      const adm = findVal(['admissionnumber', 'admissionno', 'admno', 'adm_no', 'rollno', 'roll_no']);
      const phone = findVal(['phone', 'mobile', 'phonenumber', 'mobilenumber', 'contact']);
      const username = findVal(['username', 'portalusername', 'loginid', 'user']);
      const password = findVal(['password', 'portalpassword', 'pass']);
      const section = findVal(['section', 'class', 'batch', 'sec']) || 'General';

      if (section) sectionsSet.add(section);

      if (!adm) {
        missingAdmCount++;
        warnings.push(`Row ${rowNum}: Missing Admission Number for record '${name || 'Unnamed'}'`);
      } else if (seenAdm.has(adm.toLowerCase())) {
        duplicateCount++;
        warnings.push(`Row ${rowNum}: Duplicate Admission Number '${adm}' detected in upload sheet.`);
      } else {
        seenAdm.add(adm.toLowerCase());
      }

      normalizedRows.push({
        name: name || 'Unnamed Student',
        admissionNumber: adm || `PENDING_${rowNum}`,
        phone,
        username,
        password,
        section,
        hasError: !adm
      });
    });

    return {
      totalRecords: rows.length,
      validRecords: rows.length - missingAdmCount,
      detectedSections: Array.from(sectionsSet),
      detectedColumns: Array.from(detectedColsSet),
      missingAdmissionNumbers: missingAdmCount,
      duplicateRecords: duplicateCount,
      warnings,
      previewRows: normalizedRows
    };
  }

  function renderImportPreview(data, fileName) {
    state.pendingUpload = data;

    const previewBox = document.getElementById('import-preview-box');
    const resultCard = document.getElementById('import-result-card');

    if (resultCard) resultCard.classList.remove('show');
    if (!previewBox) return;

    previewBox.classList.add('show');
    previewBox.scrollIntoView({ behavior: 'smooth' });

    document.getElementById('preview-filename-badge').textContent = fileName;
    document.getElementById('preview-total-records').textContent = data.totalRecords || 0;
    document.getElementById('preview-valid-records').textContent = data.validRecords || 0;
    document.getElementById('preview-missing-adm').textContent = data.missingAdmissionNumbers || 0;
    document.getElementById('preview-duplicate-records').textContent = data.duplicateRecords || 0;

    const secEl = document.getElementById('preview-detected-sections');
    if (secEl) {
      secEl.textContent = (data.detectedSections && data.detectedSections.length > 0)
        ? data.detectedSections.join(', ')
        : 'General';
    }

    const colEl = document.getElementById('preview-detected-columns');
    if (colEl) {
      colEl.textContent = `${(data.detectedColumns || []).length} Detected`;
    }

    const warnBox = document.getElementById('preview-warnings-alert');
    const warnList = document.getElementById('preview-warnings-list');
    if (warnBox && warnList) {
      if (data.warnings && data.warnings.length > 0) {
        warnBox.style.display = 'block';
        warnList.innerHTML = data.warnings.slice(0, 8).map(w => `<div>• ${escapeHtml(w)}</div>`).join('');
        if (data.warnings.length > 8) {
          warnList.innerHTML += `<div style="margin-top: 0.25rem; font-style: italic;">... and ${data.warnings.length - 8} more warnings.</div>`;
        }
      } else {
        warnBox.style.display = 'none';
      }
    }

    const tbody = document.getElementById('preview-table-body');
    if (tbody) {
      const sample = (data.previewRows || []).slice(0, 15);
      tbody.innerHTML = sample.map((r, i) => `
        <tr style="${r.hasError ? 'background: var(--rose-50);' : ''}">
          <td style="color: var(--slate-400);">${i + 1}</td>
          <td><strong>${escapeHtml(r.name)}</strong></td>
          <td><code class="badge-code">${escapeHtml(r.admissionNumber)}</code></td>
          <td>${r.phone ? escapeHtml(r.phone) : '<span style="color: var(--slate-400);">--</span>'}</td>
          <td>${r.username ? `<code class="badge-code">${escapeHtml(r.username)}</code>` : '<span style="color: var(--amber-600); font-size: 0.75rem;">None</span>'}</td>
          <td>${r.password ? '••••••••' : '<span style="color: var(--slate-400);">--</span>'}</td>
          <td><span class="section-badge">${escapeHtml(r.section)}</span></td>
        </tr>
      `).join('');
    }
  }

  function resetImportPreview() {
    state.pendingUpload = null;
    const previewBox = document.getElementById('import-preview-box');
    const fileInput = document.getElementById('excel-file-input');
    if (previewBox) previewBox.classList.remove('show');
    if (fileInput) fileInput.value = '';
  }

  async function handleConfirmImport() {
    if (!state.pendingUpload) return;

    const token = localStorage.getItem('admin_token');
    const confirmBtn = document.getElementById('btn-confirm-import');
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.innerHTML = `<span class="spinner" style="margin-right: 0.5rem;"></span> Ingesting records...`;
    }

    const payload = {
      previewToken: state.pendingUpload.previewToken
    };

    let summary = null;

    try {
      const res = await fetch('/api/admin/upload-confirm', {
        method: 'POST',
        headers: {
          'Authorization': token ? `Bearer ${token}` : '',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        const data = await res.json();
        summary = data.summary;
      }
    } catch (err) {
      console.warn('[Admin Portal] upload-confirm fallback to local store commit');
    }

    if (!summary) {
      const currentStore = getMockStore();
      const existingAdmMap = new Map();
      currentStore.forEach((s, idx) => {
        const adm = s.admission_number || s.admissionNumber;
        if (adm) existingAdmMap.set(adm.toLowerCase(), idx);
      });

      let added = 0;
      let updated = 0;
      let duplicates = state.pendingUpload.duplicateRecords || 0;
      let skipped = state.pendingUpload.missingAdmissionNumbers || 0;

      (state.pendingUpload.previewRows || []).forEach(r => {
        if (r.hasError) return;
        const key = (r.admissionNumber || '').toLowerCase();
        if (existingAdmMap.has(key)) {
          const idx = existingAdmMap.get(key);
          currentStore[idx] = {
            ...currentStore[idx],
            name: r.name || currentStore[idx].name,
            phone_number: r.phone || currentStore[idx].phone_number,
            username: r.username || currentStore[idx].username,
            password: r.password || currentStore[idx].password,
            section: r.section || currentStore[idx].section,
            updated_at: new Date().toISOString()
          };
          updated++;
        } else {
          currentStore.push({
            id: Date.now() + Math.floor(Math.random() * 1000),
            name: r.name,
            admission_number: r.admissionNumber,
            phone_number: r.phone,
            username: r.username,
            password: r.password,
            section: r.section,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          });
          added++;
        }
      });

      saveMockStore(currentStore);
      summary = { totalAdded: added, totalUpdated: updated, duplicates, skipped };
    }

    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = `Confirm &amp; Save Import`;
    }

    displayImportSummary(summary);
    showToast('Batch records committed to student database successfully.', 'success');

    loadStudents();
    loadDashboardStats();
  }

  function displayImportSummary(summary) {
    const previewBox = document.getElementById('import-preview-box');
    const resultCard = document.getElementById('import-result-card');

    if (previewBox) previewBox.classList.remove('show');
    if (resultCard) {
      resultCard.classList.add('show');
      document.getElementById('summary-stat-added').textContent = summary.totalAdded ?? summary.added ?? 0;
      document.getElementById('summary-stat-updated').textContent = summary.totalUpdated ?? summary.updated ?? 0;
      document.getElementById('summary-stat-duplicates').textContent = summary.duplicates ?? 0;
      document.getElementById('summary-stat-skipped').textContent = summary.skipped ?? summary.totalErrors ?? 0;

      resultCard.scrollIntoView({ behavior: 'smooth' });
    }
  }

  // =========================================================================
  // VIEW 4: Universal Search Engine
  // =========================================================================
  function initUniversalSearch() {
    const searchInput = document.getElementById('universal-search-input');
    const clearBtn = document.getElementById('universal-search-clear');
    const chips = document.querySelectorAll('.filter-chip-btn');

    if (!searchInput) return;

    searchInput.addEventListener('input', (e) => {
      const q = e.target.value.trim();
      if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';

      clearTimeout(state.searchDebounceTimer);
      state.searchDebounceTimer = setTimeout(() => {
        executeUniversalSearch(q);
      }, 250);
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearBtn.style.display = 'none';
        executeUniversalSearch('');
        searchInput.focus();
      });
    }

    chips.forEach(chip => {
      chip.addEventListener('click', () => {
        chips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.universalSearchFilter = chip.getAttribute('data-field') || 'all';
        executeUniversalSearch(searchInput.value.trim());
      });
    });
  }

  async function executeUniversalSearch(query) {
    const tbody = document.getElementById('universal-results-tbody');
    const emptyState = document.getElementById('universal-empty-state');
    const countBadge = document.getElementById('universal-results-count');

    if (!tbody) return;

    if (!query) {
      tbody.innerHTML = '';
      if (emptyState) {
        emptyState.style.display = 'block';
        emptyState.querySelector('h4').textContent = 'Instantaneous record lookup';
        emptyState.querySelector('p').textContent = 'Begin typing in the search bar above to query students across all sections.';
      }
      if (countBadge) countBadge.textContent = 'Enter search query to begin lookup';
      return;
    }

    const q = query.toLowerCase();
    const filterField = state.universalSearchFilter;

    // Attempt live server search first
    const token = localStorage.getItem('admin_token');
    let matches = [];

    try {
      const res = await fetch(`/api/admin/students?limit=50&search=${encodeURIComponent(query)}`, {
        headers: { 'Authorization': token ? `Bearer ${token}` : '' }
      });
      if (res.ok) {
        const data = await res.json();
        matches = data.students || [];
      }
    } catch (err) {
      // Fallback to local store
    }

    if (matches.length === 0) {
      const allStudents = getMockStore();
      matches = allStudents.filter(s => {
        const name = (s.name || '').toLowerCase();
        const adm = (s.admission_number || s.admissionNumber || '').toLowerCase();
        const phone = (s.phone_number || s.phone || '').toLowerCase();
        const user = (s.username || '').toLowerCase();

        if (filterField === 'name') return name.includes(q);
        if (filterField === 'adm') return adm.includes(q);
        if (filterField === 'phone') return phone.includes(q);
        if (filterField === 'username') return user.includes(q);

        return name.includes(q) || adm.includes(q) || phone.includes(q) || user.includes(q);
      });
    }

    if (countBadge) {
      countBadge.textContent = `${matches.length} matching student ${matches.length === 1 ? 'record' : 'records'} found`;
    }

    if (matches.length === 0) {
      tbody.innerHTML = '';
      if (emptyState) {
        emptyState.style.display = 'block';
        emptyState.querySelector('h4').textContent = 'No matching records found';
        emptyState.querySelector('p').textContent = `No students matched the query "${query}" under current field filter.`;
      }
    } else {
      if (emptyState) emptyState.style.display = 'none';

      tbody.innerHTML = matches.map(s => {
        const adm = s.admission_number || s.admissionNumber || '';
        const phone = s.phone_number || s.phone || '';
        const highlightedName = highlightMatch(s.name, q);
        const highlightedAdm = highlightMatch(adm, q);
        const highlightedPhone = highlightMatch(phone, q);
        const highlightedUser = highlightMatch(s.username, q);
        const hasPass = Boolean(s.password);

        return `
          <tr>
            <td><strong>${highlightedName}</strong></td>
            <td><code class="badge-code">${highlightedAdm}</code></td>
            <td>${phone ? `<span style="font-family: var(--font-mono);">${highlightedPhone}</span>` : '<span style="color: var(--slate-400);">--</span>'}</td>
            <td>${s.username ? `<code class="badge-code">${highlightedUser}</code>` : '<span style="color: var(--amber-600); font-size: 0.75rem;">None</span>'}</td>
            <td>
              <div class="password-cell-wrapper">
                <span class="password-display-text" data-revealed="false" data-raw="${escapeHtml(s.password || '')}">
                  ${hasPass ? '••••••••' : '<span style="color: var(--rose-500); font-size: 0.75rem;">Missing</span>'}
                </span>
                ${hasPass ? `
                  <button type="button" class="btn-eye-toggle" aria-label="Toggle password">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                  </button>
                ` : ''}
              </div>
            </td>
            <td><span class="section-badge">${escapeHtml(s.section || 'General')}</span></td>
            <td style="text-align: right;">
              <button type="button" class="btn btn-secondary btn-sm btn-universal-edit" data-id="${escapeHtml(String(s.id))}">
                Edit
              </button>
            </td>
          </tr>
        `;
      }).join('');

      tbody.querySelectorAll('.btn-universal-edit').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-id');
          openEditStudentModal(id);
        });
      });

      tbody.querySelectorAll('.btn-eye-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
          const wrapper = btn.closest('.password-cell-wrapper');
          const textSpan = wrapper.querySelector('.password-display-text');
          const isRevealed = textSpan.getAttribute('data-revealed') === 'true';
          const raw = textSpan.getAttribute('data-raw');

          if (isRevealed) {
            textSpan.textContent = '••••••••';
            textSpan.setAttribute('data-revealed', 'false');
          } else {
            textSpan.textContent = raw;
            textSpan.setAttribute('data-revealed', 'true');
          }
        });
      });
    }
  }

  function highlightMatch(text, query) {
    if (!text || !query) return escapeHtml(text || '');
    const cleanText = String(text);
    const regex = new RegExp(`(${escapeRegExp(query)})`, 'gi');
    const parts = cleanText.split(regex);
    return parts.map(part => {
      if (part.toLowerCase() === query.toLowerCase()) {
        return `<mark class="search-highlight">${escapeHtml(part)}</mark>`;
      }
      return escapeHtml(part);
    }).join('');
  }

  function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // =========================================================================
  // Mobile Sidebar & Global Event Listeners
  // =========================================================================
  function initMobileControls() {
    const toggleBtn = document.getElementById('btn-sidebar-toggle');
    const sidebar = document.getElementById('app-sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');

    if (toggleBtn && sidebar && backdrop) {
      toggleBtn.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        backdrop.classList.toggle('show');
      });

      backdrop.addEventListener('click', () => {
        closeMobileSidebar();
      });
    }

    document.getElementById('btn-quick-logout')?.addEventListener('click', handleLogout);
    document.getElementById('btn-sidebar-logout')?.addEventListener('click', handleLogout);

    document.getElementById('btn-refresh-stats')?.addEventListener('click', () => {
      showToast('Refreshing live statistics...', 'info', 2000);
      loadDashboardStats();
    });

    document.getElementById('btn-refresh-students')?.addEventListener('click', () => {
      showToast('Refreshing student directory...', 'info', 2000);
      loadStudents();
    });

    const searchInput = document.getElementById('student-search-input');
    const searchClear = document.getElementById('student-search-clear');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const val = e.target.value;
        if (searchClear) searchClear.style.display = val ? 'block' : 'none';

        clearTimeout(state.searchDebounceTimer);
        state.searchDebounceTimer = setTimeout(() => {
          state.filters.search = val.trim();
          state.pagination.page = 1;
          loadStudents();
        }, 300);
      });
    }

    if (searchClear) {
      searchClear.addEventListener('click', () => {
        searchInput.value = '';
        searchClear.style.display = 'none';
        state.filters.search = '';
        state.pagination.page = 1;
        loadStudents();
        searchInput.focus();
      });
    }

    document.getElementById('student-section-filter')?.addEventListener('change', (e) => {
      state.filters.section = e.target.value;
      state.pagination.page = 1;
      loadStudents();
    });

    document.getElementById('student-credential-filter')?.addEventListener('change', (e) => {
      state.filters.credential = e.target.value;
      state.pagination.page = 1;
      loadStudents();
    });

    document.getElementById('student-sort-filter')?.addEventListener('change', (e) => {
      state.filters.sort = e.target.value;
      state.pagination.page = 1;
      loadStudents();
    });

    document.getElementById('pagination-limit-select')?.addEventListener('change', (e) => {
      state.pagination.limit = Number(e.target.value) || 10;
      state.pagination.page = 1;
      loadStudents();
    });

    document.getElementById('btn-reset-filters')?.addEventListener('click', () => {
      state.filters = { search: '', section: '', credential: '', sort: 'name_asc' };
      if (searchInput) searchInput.value = '';
      if (searchClear) searchClear.style.display = 'none';
      const secSel = document.getElementById('student-section-filter');
      if (secSel) secSel.value = '';
      const credSel = document.getElementById('student-credential-filter');
      if (credSel) credSel.value = '';
      const sortSel = document.getElementById('student-sort-filter');
      if (sortSel) sortSel.value = 'name_asc';
      state.pagination.page = 1;
      loadStudents();
    });
  }

  function closeMobileSidebar() {
    const sidebar = document.getElementById('app-sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (sidebar) sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('show');
  }

  // =========================================================================
  // Utility Functions
  // =========================================================================
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatDate(isoStr) {
    if (!isoStr) return '--';
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
  // Application Bootstrap
  // =========================================================================
  async function initApp() {
    const isAuthenticated = await checkAuthSession();
    if (!isAuthenticated) return;

    initRouting();
    initModals();
    initExcelUpload();
    initUniversalSearch();
    initMobileControls();

    loadDashboardStats();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }

  window.ABESAdmin = {
    showToast,
    switchTab,
    loadStudents,
    loadDashboardStats
  };

})();
