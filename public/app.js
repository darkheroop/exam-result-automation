/**
 * Educational Examination Result Retrieval & Annual Marksheet Portal Client
 * Modern Institutional Client Application (No PDF triggers)
 */

(() => {
  'use strict';

  // ============================================================================
  // Application State
  // ============================================================================
  let currentSession = null;
  let statusPollTimer = null;
  let isSubmitting = false;
  let activeRequestId = 0;
  let activeFetchController = null;
  let currentTab = 'all';
  let cachedSemesters = [];
  let currentResultData = null;

  // ============================================================================
  // DOM Elements - Search & Form
  // ============================================================================
  const fetchForm = document.getElementById('fetchForm');
  const studentNumberInput = document.getElementById('studentNumberInput');
  const inputClearBtn = document.getElementById('inputClearBtn');
  const inputValidationError = document.getElementById('inputValidationError');
  const fetchResultBtn = document.getElementById('fetchResultBtn');

  // Dashboard & Views
  const dashboardSection = document.getElementById('dashboardSection');
  const resultSection = document.getElementById('resultSection');
  const headerActions = document.getElementById('headerActions');
  const headerNewSearchBtn = document.getElementById('headerNewSearchBtn');
  const closeSessionBtn = document.getElementById('closeSessionBtn');

  // Progress Tracking
  const progressCard = document.getElementById('progressCard');
  const progressBar = document.getElementById('progressBar');
  const progressPercentBadge = document.getElementById('progressPercentBadge');
  const progressMessage = document.getElementById('progressMessage');
  const stepItems = document.querySelectorAll('.step-item');

  // Error Card
  const errorCard = document.getElementById('errorCard');
  const errorMessage = document.getElementById('errorMessage');
  const errorRetryBtn = document.getElementById('errorRetryBtn');

  // Results View Meta
  const resultStudentId = document.getElementById('resultStudentId');
  const resultSemesterTitle = document.getElementById('resultSemesterTitle');
  const pendingResultAlert = document.getElementById('pendingResultAlert');
  const marksheetCollegeTitle = document.getElementById('marksheetCollegeTitle');
  const marksheetSubtitle = document.getElementById('marksheetSubtitle');

  // Student Biographical Info Elements
  const studName = document.getElementById('studName');
  const studRollNo = document.getElementById('studRollNo');
  const studSeatNo = document.getElementById('studSeatNo');
  const studPnrNo = document.getElementById('studPnrNo');
  const studAcadYear = document.getElementById('studAcadYear');
  const studRegnNo = document.getElementById('studRegnNo');
  const studAbcId = document.getElementById('studAbcId');
  const studPublishedOn = document.getElementById('studPublishedOn');
  const studSemesters = document.getElementById('studSemesters');
  const studClass = document.getElementById('studClass');
  const studSession = document.getElementById('studSession');

  // Annual Performance KPI Cards
  const kpiSem1Sgpa = document.getElementById('kpiSem1Sgpa');
  const kpiSem2Sgpa = document.getElementById('kpiSem2Sgpa');
  const kpiSem1Sub = document.getElementById('kpiSem1Sub');
  const kpiSem2Sub = document.getElementById('kpiSem2Sub');
  const kpiYgpa = document.getElementById('kpiYgpa');
  const kpiCreditsEarned = document.getElementById('kpiCreditsEarned');
  const kpiTotalCredits = document.getElementById('kpiTotalCredits');
  const kpiCreditsPercent = document.getElementById('kpiCreditsPercent');
  const kpiOverallStatus = document.getElementById('kpiOverallStatus');
  const kpiCopStatus = document.getElementById('kpiCopStatus');

  // Semester Tab Switcher
  const tabBtnAll = document.getElementById('tabBtnAll');
  const tabBtnSem1 = document.getElementById('tabBtnSem1');
  const tabBtnSem2 = document.getElementById('tabBtnSem2');
  const tabBadgeAll = document.getElementById('tabBadgeAll');
  const tabBadgeSem1 = document.getElementById('tabBadgeSem1');
  const tabBadgeSem2 = document.getElementById('tabBadgeSem2');
  const tabStatusSummary = document.getElementById('tabStatusSummary');

  // Container Elements
  const semestersContainer = document.getElementById('semestersContainer');
  const iframeContainer = document.getElementById('iframeContainer');
  const portalViewFrame = document.getElementById('portalViewFrame');


  // ============================================================================
  // Input Validation & Helpers
  // ============================================================================

  function validateInput(value) {
    const trimmed = (value || '').trim();
    if (!trimmed) {
      return { valid: false, message: 'Please enter a student identifier.' };
    }
    if (!/^\d{10}$/.test(trimmed)) {
      return { valid: false, message: 'Please enter a valid 10-digit number.' };
    }
    return { valid: true, value: trimmed };
  }

  function showInputError(msg) {
    inputValidationError.textContent = msg;
    inputValidationError.classList.remove('hidden');
    studentNumberInput.classList.add('is-invalid');
  }

  function clearInputError() {
    inputValidationError.classList.add('hidden');
    studentNumberInput.classList.remove('is-invalid');
  }

  function updateClearButton() {
    if (studentNumberInput.value.trim().length > 0) {
      inputClearBtn.classList.remove('hidden');
    } else {
      inputClearBtn.classList.add('hidden');
    }
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function clearResultView() {
    currentResultData = null;
    resultStudentId.textContent = '—';
    resultSemesterTitle.textContent = 'Annual Result';

    // Reset student info
    if (studName) studName.textContent = '—';
    if (studRollNo) studRollNo.textContent = '—';
    if (studSeatNo) studSeatNo.textContent = '—';
    if (studPnrNo) studPnrNo.textContent = '—';
    if (studAcadYear) studAcadYear.textContent = '—';
    if (studRegnNo) studRegnNo.textContent = '—';
    if (studAbcId) studAbcId.textContent = '—';
    if (studPublishedOn) studPublishedOn.textContent = '—';
    if (studSemesters) studSemesters.textContent = '—';
    if (studClass) studClass.textContent = '—';
    if (studSession) studSession.textContent = '—';

    // Reset KPI cards
    if (kpiSem1Sgpa) kpiSem1Sgpa.textContent = '—';
    if (kpiSem2Sgpa) kpiSem2Sgpa.textContent = '—';
    if (kpiSem1Sub) kpiSem1Sub.textContent = 'Sem I Assessment';
    if (kpiSem2Sub) kpiSem2Sub.textContent = 'Sem II Assessment';
    if (kpiYgpa) kpiYgpa.textContent = '—';
    if (kpiCreditsEarned) kpiCreditsEarned.textContent = '—';
    if (kpiTotalCredits) kpiTotalCredits.textContent = '/ —';
    if (kpiCreditsPercent) kpiCreditsPercent.textContent = 'Credits Completed';
    if (kpiOverallStatus) {
      kpiOverallStatus.textContent = '—';
      kpiOverallStatus.className = 'kpi-status-pill';
    }
    if (kpiCopStatus) kpiCopStatus.textContent = 'COP: None';

    // Reset Tabs
    currentTab = 'all';
    cachedSemesters = [];
    setActiveTabButton('all');
    if (tabBadgeAll) tabBadgeAll.textContent = 'Annual';
    if (tabBadgeSem1) tabBadgeSem1.textContent = '—';
    if (tabBadgeSem2) tabBadgeSem2.textContent = '—';
    if (tabBtnSem1) tabBtnSem1.disabled = false;
    if (tabBtnSem2) tabBtnSem2.disabled = false;
    if (tabStatusSummary) {
      tabStatusSummary.textContent = 'Showing comprehensive annual performance records';
    }

    // Reset Container
    if (semestersContainer) semestersContainer.innerHTML = '';
    if (portalViewFrame) portalViewFrame.srcdoc = '';
    if (iframeContainer) iframeContainer.classList.add('hidden');
    if (pendingResultAlert) pendingResultAlert.classList.add('hidden');
  }

  // ============================================================================
  // View & Progress Controllers
  // ============================================================================

  function setProgressState(percent, messageText, currentStage = 1) {
    progressCard.classList.remove('hidden');
    errorCard.classList.add('hidden');

    progressBar.style.width = `${percent}%`;
    progressPercentBadge.textContent = `${percent}%`;
    progressMessage.textContent = messageText;

    stepItems.forEach((item) => {
      const stepNum = parseInt(item.getAttribute('data-step'), 10);
      item.classList.remove('active', 'completed');
      if (stepNum < currentStage) {
        item.classList.add('completed');
      } else if (stepNum === currentStage) {
        item.classList.add('active');
      }
    });
  }

  function showWorkflowError(msg) {
    stopPolling();
    isSubmitting = false;
    resetFetchButton();

    progressCard.classList.add('hidden');
    errorMessage.textContent = msg || 'An error occurred during portal automation.';
    errorCard.classList.remove('hidden');
  }

  function resetFetchButton() {
    studentNumberInput.disabled = false;
    fetchResultBtn.disabled = false;
    fetchResultBtn.querySelector('.btn-text').textContent = 'Fetch Result';
    fetchResultBtn.querySelector('.btn-spinner').classList.add('hidden');
  }

  function setFetchButtonLoading() {
    studentNumberInput.disabled = true;
    fetchResultBtn.disabled = true;
    fetchResultBtn.querySelector('.btn-text').textContent = 'Processing...';
    fetchResultBtn.querySelector('.btn-spinner').classList.remove('hidden');
  }

  // ============================================================================
  // Polling Status
  // ============================================================================

  function startPolling(sessionId, sessionToken, targetStudentNumber, reqId) {
    stopPolling();
    let consecutiveErrors = 0;

    statusPollTimer = setInterval(async () => {
      // Abort if request has been superseded
      if (reqId !== activeRequestId) {
        stopPolling();
        return;
      }

      try {
        const res = await fetch(`/api/automation/status/${sessionId}`, {
          headers: {
            'x-session-token': sessionToken,
            'Accept': 'application/json'
          }
        });

        // Abort if request was superseded while fetch was in flight
        if (reqId !== activeRequestId) return;

        if (!res.ok) {
          consecutiveErrors++;
          if (consecutiveErrors <= 5) return;
          const errData = await res.json().catch(() => ({}));
          showWorkflowError(errData.error?.message || 'Unable to check automation status.');
          return;
        }

        consecutiveErrors = 0;
        const json = await res.json();
        const data = json.data;

        if (!data || reqId !== activeRequestId) return;

        // Security check: verify status payload belongs to target student
        if (data.studentIdentifier && targetStudentNumber && data.studentIdentifier !== targetStudentNumber) {
          console.warn(`[Client] Ignoring stale poll response for student ${data.studentIdentifier}, expected ${targetStudentNumber}`);
          return;
        }

        if (data.status === 'error') {
          showWorkflowError(data.error?.message || 'Automation workflow failed.');
          return;
        }

        let stageMsg = data.stageMessage;
        if (data.status === 'queued') {
          stageMsg = data.queuePosition
            ? `In queue (position ${data.queuePosition}). Processing shortly...`
            : (stageMsg || 'In queue. Processing shortly...');
        }

        setProgressState(data.progressPercent, stageMsg, data.stage);

        if (data.status === 'ready' || data.status === 'download_ready' || data.resultData) {
          stopPolling();
          transitionToResultView(data, targetStudentNumber, reqId);
        }
      } catch (err) {
        if (reqId !== activeRequestId) return;
        consecutiveErrors++;
        console.warn('Transient polling error:', err.message);
        if (consecutiveErrors > 6) {
          showWorkflowError('Network connection lost while waiting for examination results.');
        }
      }
    }, 1200);
  }

  function stopPolling() {
    if (statusPollTimer) {
      clearInterval(statusPollTimer);
      statusPollTimer = null;
    }
  }

  // ============================================================================
  // Transition to Result Screen & Marksheet Rendering
  // ============================================================================

  function transitionToResultView(sessionData, targetStudentNumber = null, reqId = null) {
    if (reqId && reqId !== activeRequestId) return;

    // Strict identity match guard
    const expectedStudent = targetStudentNumber || currentSession?.studentNumber;
    if (expectedStudent) {
      if (sessionData.studentIdentifier && sessionData.studentIdentifier !== expectedStudent) {
        console.error(`[Client] Identity mismatch in transitionToResultView: got ${sessionData.studentIdentifier}, expected ${expectedStudent}`);
        return;
      }
      if (sessionData.resultData?.student?.studentNumber && sessionData.resultData.student.studentNumber !== expectedStudent) {
        console.error(`[Client] Identity mismatch in resultData.student: got ${sessionData.resultData.student.studentNumber}, expected ${expectedStudent}`);
        return;
      }
    }

    isSubmitting = false;
    resetFetchButton();

    document.querySelector('.app-main')?.classList.add('results-mode');
    dashboardSection.classList.add('hidden');
    resultSection.classList.remove('hidden');
    headerActions.classList.remove('hidden');

    resultStudentId.textContent = expectedStudent || '—';
    resultSemesterTitle.textContent = sessionData.examSummary?.title || 'Annual Result';

    const result = sessionData.resultData;
    currentResultData = result || null;

    if (result && result.student) {
      const s = result.student;

      // 1. Institution Metadata
      if (result.institution) {
        if (marksheetCollegeTitle) {
          marksheetCollegeTitle.textContent = result.institution.headerTitle || result.institution.name || 'ABES Engineering College : Annual Result';
        }
        if (marksheetSubtitle) {
          marksheetSubtitle.textContent = `${result.institution.subTitle || '(Autonomous College)'} • ${result.institution.accreditation || 'NAAC Accredited'}`;
        }
      }

      // 2. Populate Student Biographical Information
      if (studName) studName.textContent = s.fullName || s.name || 'STUDENT';
      if (studRollNo) studRollNo.textContent = s.rollNo || s.regnNo || s.seatNo || '—';
      if (studSeatNo) studSeatNo.textContent = s.seatNo || '—';
      if (studPnrNo) studPnrNo.textContent = s.pnrNo || s.abcId || '—';
      if (studAcadYear) studAcadYear.textContent = s.academicYear || '—';
      if (studRegnNo) studRegnNo.textContent = s.regnNo || s.seatNo || '—';
      if (studAbcId) studAbcId.textContent = s.abcId || '—';
      if (studPublishedOn) studPublishedOn.textContent = s.publishedOn || '—';
      if (studSemesters) studSemesters.textContent = s.semesters || '1, 2';
      if (studClass) studClass.textContent = s.course || s.className || 'Bachelor of Technology';
      if (studSession) studSession.textContent = s.session || `${s.academicYear || '2025'} (REGULAR)`;

      // 3. Process Semesters & KPI Cards
      const rawSemesters = Array.isArray(result.semesters) ? result.semesters : [];
      cachedSemesters = rawSemesters;

      populateKpiCards(result, rawSemesters);
      setupSemesterTabs(rawSemesters);

      // Render marksheet tables based on active tab
      renderMarksheetTables(rawSemesters, currentTab);
      iframeContainer.classList.add('hidden');

      if (result.annualSummary?.status === 'PENDING' || s.status === 'PENDING') {
        pendingResultAlert.classList.remove('hidden');
      } else {
        pendingResultAlert.classList.add('hidden');
      }

    } else if (sessionData.renderedHtml) {
      // Fallback: If only raw HTML was captured
      iframeContainer.classList.remove('hidden');
      portalViewFrame.srcdoc = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <base href="https://ai-edunova.abes.ac.in/">
          <link rel="stylesheet" href="https://ai-edunova.abes.ac.in/styles-2NQPLNDH.css">
          <style>
            top-navbar, .top-navbar, app-topbar, .layout-topbar, nav.p-breadcrumb, .p-breadcrumb,
            app-floating-configurator, app-configurator, app-sidebar, de-loader, [class*="backdrop-blur"] { display: none !important; }
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important; background: #fff !important; margin: 0; padding: 1rem !important; }
          </style>
        </head>
        <body>${sessionData.renderedHtml}</body>
        </html>
      `;
    }
  }

  /**
   * Defensive KPI Card Population:
   * Displays Semester I SGPA, Semester II SGPA, Overall YGPA, Total Credits Earned, Overall Result/Remarks
   */
  function populateKpiCards(result, semesters) {
    const s = result.student || {};
    const summary = result.annualSummary || {};

    // Find Sem 1 and Sem 2 objects defensively
    const sem1 = semesters.find(x => x.semesterNumber === 1 || String(x.title || x.semesterTitle || '').toUpperCase().includes('SEMESTER I')) || (semesters.length > 0 ? semesters[0] : null);
    const sem2 = semesters.find(x => x.semesterNumber === 2 || String(x.title || x.semesterTitle || '').toUpperCase().includes('SEMESTER II')) || (semesters.length > 1 ? semesters[1] : null);

    // Sem I SGPA
    if (kpiSem1Sgpa) {
      kpiSem1Sgpa.textContent = (sem1 && sem1.sgpa !== undefined && sem1.sgpa !== '') ? sem1.sgpa : '—';
    }
    if (kpiSem1Sub) {
      if (sem1) {
        const earned = sem1.creditsEarned !== undefined ? sem1.creditsEarned : sem1.credits;
        kpiSem1Sub.textContent = `Earned ${earned || '—'} / ${sem1.credits || '—'} Credits`;
      } else {
        kpiSem1Sub.textContent = 'Not Assessed';
      }
    }

    // Sem II SGPA
    if (kpiSem2Sgpa) {
      kpiSem2Sgpa.textContent = (sem2 && sem2.sgpa !== undefined && sem2.sgpa !== '') ? sem2.sgpa : '—';
    }
    if (kpiSem2Sub) {
      if (sem2) {
        const earned = sem2.creditsEarned !== undefined ? sem2.creditsEarned : sem2.credits;
        kpiSem2Sub.textContent = `Earned ${earned || '—'} / ${sem2.credits || '—'} Credits`;
      } else {
        kpiSem2Sub.textContent = 'Not Assessed';
      }
    }

    // Overall YGPA
    if (kpiYgpa) {
      let ygpaVal = summary.ygpa || s.ygpa;
      if (!ygpaVal && sem1 && sem2 && sem1.sgpa && sem2.sgpa) {
        const avg = ((parseFloat(sem1.sgpa) + parseFloat(sem2.sgpa)) / 2).toFixed(2);
        ygpaVal = isNaN(avg) ? '—' : avg;
      }
      kpiYgpa.textContent = ygpaVal || sem1?.sgpa || '—';
    }

    // Total Credits Earned
    const totalEarnedCredits = summary.creditsEarned !== undefined ? summary.creditsEarned : (s.creditsEarned !== undefined ? s.creditsEarned : semesters.reduce((acc, sem) => acc + (sem.creditsEarned !== undefined ? Number(sem.creditsEarned) : (sem.credits ? Number(sem.credits) : 0)), 0));
    const totalMaxCredits = summary.totalCredits !== undefined ? summary.totalCredits : (s.totalCredits !== undefined ? s.totalCredits : semesters.reduce((acc, sem) => acc + (sem.credits ? Number(sem.credits) : 0), 0));

    if (kpiCreditsEarned) {
      kpiCreditsEarned.textContent = totalEarnedCredits !== undefined && totalEarnedCredits !== '' ? totalEarnedCredits : '—';
    }
    if (kpiTotalCredits) {
      kpiTotalCredits.textContent = totalMaxCredits ? `/ ${totalMaxCredits}` : '';
    }
    if (kpiCreditsPercent) {
      if (totalMaxCredits && totalEarnedCredits) {
        const pct = Math.min(100, Math.round((Number(totalEarnedCredits) / Number(totalMaxCredits)) * 100));
        kpiCreditsPercent.textContent = `${pct}% Requirements Satisfied`;
      } else {
        kpiCreditsPercent.textContent = 'Credits Completed';
      }
    }

    // Overall Status / Remarks
    const rawStatus = (summary.status || s.status || 'PASS').toUpperCase();
    if (kpiOverallStatus) {
      kpiOverallStatus.textContent = rawStatus;
      kpiOverallStatus.className = 'kpi-status-pill ' + (rawStatus === 'PASS' ? 'pill-pass' : (rawStatus === 'PWG' ? 'pill-pwg' : 'pill-fail'));
    }

    const cop = summary.cop || s.cop;
    if (kpiCopStatus) {
      if (cop && cop !== '—' && cop !== 'None' && String(cop).trim().length > 0) {
        kpiCopStatus.textContent = `COP / Backlogs: ${cop}`;
        kpiCopStatus.classList.add('has-cop');
      } else {
        kpiCopStatus.textContent = 'Clear • No Active Backlogs';
        kpiCopStatus.classList.remove('has-cop');
      }
    }
  }

  /**
   * Set up tab switcher controls based on available semesters
   */
  function setupSemesterTabs(semesters) {
    const semCount = semesters.length;
    if (tabBadgeAll) {
      tabBadgeAll.textContent = semCount > 1 ? `${semCount} Semesters` : (semCount === 1 ? '1 Semester' : 'Annual');
    }

    const sem1 = semesters.find(x => x.semesterNumber === 1 || String(x.title || '').toUpperCase().includes('SEMESTER I')) || (semCount > 0 ? semesters[0] : null);
    const sem2 = semesters.find(x => x.semesterNumber === 2 || String(x.title || '').toUpperCase().includes('SEMESTER II')) || (semCount > 1 ? semesters[1] : null);

    if (tabBadgeSem1) {
      tabBadgeSem1.textContent = sem1 ? (sem1.sgpa ? `SGPA ${sem1.sgpa}` : `${(sem1.subjects || []).length} Subjects`) : 'N/A';
    }
    if (tabBadgeSem2) {
      tabBadgeSem2.textContent = sem2 ? (sem2.sgpa ? `SGPA ${sem2.sgpa}` : `${(sem2.subjects || []).length} Subjects`) : 'N/A';
    }

    if (tabBtnSem1) tabBtnSem1.disabled = !sem1;
    if (tabBtnSem2) tabBtnSem2.disabled = !sem2;
  }

  function setActiveTabButton(tabKey) {
    currentTab = tabKey;
    [tabBtnAll, tabBtnSem1, tabBtnSem2].forEach(btn => {
      if (!btn) return;
      const isMatch = btn.getAttribute('data-tab') === tabKey;
      btn.classList.toggle('active', isMatch);
      btn.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    });

    if (tabStatusSummary) {
      if (tabKey === 'all') {
        tabStatusSummary.textContent = 'Showing comprehensive annual performance records (Semester I & II)';
      } else if (tabKey === '1') {
        tabStatusSummary.textContent = 'Showing Semester I curriculum & examination assessment records';
      } else if (tabKey === '2') {
        tabStatusSummary.textContent = 'Showing Semester II curriculum & examination assessment records';
      }
    }
  }

  // ============================================================================
  // Marksheet Table Rendering
  // ============================================================================

  function renderMarksheetTables(semesters, activeTab = 'all') {
    semestersContainer.innerHTML = '';

    if (!semesters || semesters.length === 0) {
      semestersContainer.innerHTML = `
        <div class="empty-marksheet-notice">
          <p>No verified semester assessment records were found in the official response.</p>
        </div>
      `;
      return;
    }

    // Filter semesters based on active tab
    const filteredSemesters = semesters.filter((sem, idx) => {
      if (activeTab === 'all') return true;
      const semNum = sem.semesterNumber || (idx + 1);
      return String(semNum) === String(activeTab);
    });

    if (filteredSemesters.length === 0) {
      semestersContainer.innerHTML = `
        <div class="empty-marksheet-notice">
          <p>No records found for the selected semester.</p>
        </div>
      `;
      return;
    }

    filteredSemesters.forEach((sem, sIdx) => {
      const semNum = sem.semesterNumber || (sIdx + 1);
      const semSec = document.createElement('div');
      semSec.className = 'semester-section';
      semSec.setAttribute('data-semester-id', `sem-${semNum}`);

      // Semester Section Header
      const semStatus = (sem.status || sem.generalRemark || 'PASS').toUpperCase();
      const statusPillClass = semStatus === 'PASS' ? 'pill-pass' : (semStatus === 'PWG' ? 'pill-pwg' : 'pill-fail');

      const semHeaderHtml = `
        <div class="semester-section-header">
          <div class="sem-header-left">
            <div class="sem-num-badge">SEM ${semNum}</div>
            <div class="sem-title-wrap">
              <h2 class="semester-title">${escapeHtml(sem.title || sem.semesterTitle || `Semester ${semNum}`)}</h2>
              <span class="sem-subtitle">Verified Institutional Assessment Record</span>
            </div>
          </div>
          <div class="sem-header-badges">
            <div class="sem-badge-item sgpa-badge">
              <span class="badge-label">SGPA</span>
              <span class="badge-value">${sem.sgpa || '—'}</span>
            </div>
            <div class="sem-badge-item credits-badge">
              <span class="badge-label">CREDITS</span>
              <span class="badge-value">${sem.creditsEarned !== undefined ? sem.creditsEarned : (sem.credits || '—')} / ${sem.credits || '—'}</span>
            </div>
            <div class="sem-badge-item status-badge">
              <span class="${statusPillClass}">${escapeHtml(semStatus)}</span>
            </div>
          </div>
        </div>
      `;

      // Build Table Rows
      let rowsHtml = '';
      const subjects = Array.isArray(sem.subjects) ? sem.subjects : [];

      subjects.forEach((sub, rowIdx) => {
        const isTheory = (sub.type || '').toUpperCase() === 'THEORY';
        const typeBadge = isTheory
          ? '<span class="badge-theory">THEORY</span>'
          : '<span class="badge-lab">LAB</span>';

        // 1. Internal / CIA
        const intCell = sub.internal
          ? `<div class="asmt-cell"><span class="cell-obt">${sub.internal.obt}</span><span class="cell-sub">/ ${sub.internal.max}</span></div>`
          : '<span class="cell-dash">—</span>';

        // 2. Mid Term 1
        const mt1Cell = isTheory && sub.midTerm1
          ? `<div class="asmt-cell"><span class="cell-obt">${sub.midTerm1.obt}</span><span class="cell-sub">/ ${sub.midTerm1.max}</span></div>`
          : '<span class="cell-dash">—</span>';

        // 3. Mid Term 2
        const mt2Cell = isTheory && sub.midTerm2
          ? `<div class="asmt-cell"><span class="cell-obt">${sub.midTerm2.obt}</span><span class="cell-sub">/ ${sub.midTerm2.max}</span></div>`
          : '<span class="cell-dash">—</span>';

        // 4. End Term
        const endTermCell = isTheory && sub.endTerm
          ? `<div class="asmt-cell"><span class="cell-obt">${sub.endTerm.obt}</span><span class="cell-sub">/ ${sub.endTerm.max}</span></div>`
          : (sub.external
              ? `<div class="asmt-cell"><span class="cell-obt">${sub.external.obt}</span><span class="cell-sub">/ ${sub.external.max}</span></div>`
              : '<span class="cell-dash">—</span>');

        // 5. Total Obtained & Max
        const totalObt = sub.total ? sub.total.obt : (sub.obtainedMarks !== undefined ? sub.obtainedMarks : '—');
        const totalMax = sub.total ? sub.total.max : (sub.maxMarks !== undefined ? sub.maxMarks : 100);

        // Grade Badge Styling
        const gradeStr = (sub.grade || '').toUpperCase();
        let gradeClass = 'grade-green';
        if (gradeStr.includes('A')) gradeClass = 'grade-purple';
        else if (gradeStr.includes('B')) gradeClass = 'grade-blue';
        else if (gradeStr.includes('C')) gradeClass = 'grade-amber';
        else if (gradeStr.includes('D')) gradeClass = 'grade-orange';
        else if (gradeStr.includes('F') || gradeStr.includes('E#')) gradeClass = 'grade-red';

        // Result Pill
        const subResult = (sub.result || 'PASS').toUpperCase();
        const subResultClass = subResult === 'PASS' ? 'pill-pass' : (subResult === 'PWG' ? 'pill-pwg' : 'pill-fail');

        // Credits
        const subCredits = sub.creditsEarned !== undefined ? sub.creditsEarned : (sub.credits !== undefined ? sub.credits : '—');

        rowsHtml += `
          <tr class="${rowIdx % 2 === 0 ? 'row-even' : 'row-odd'}">
            <td class="col-code"><span class="subject-code-tag">${escapeHtml(sub.code || '—')}</span></td>
            <td class="col-name">
              <div class="subject-title-wrap">
                <span class="subject-title-text">${escapeHtml(sub.name || sub.title || 'Course Subject')}</span>
              </div>
            </td>
            <td class="col-type">${typeBadge}</td>
            <td class="col-asmt">${intCell}</td>
            <td class="col-asmt">${mt1Cell}</td>
            <td class="col-asmt">${mt2Cell}</td>
            <td class="col-asmt">${endTermCell}</td>
            <td class="col-total-obt"><span class="total-bold">${escapeHtml(totalObt)}</span></td>
            <td class="col-max">${escapeHtml(totalMax)}</td>
            <td class="col-gp"><strong>${sub.gradePoints !== undefined ? sub.gradePoints : '—'}</strong></td>
            <td class="col-grade"><span class="cell-grade ${gradeClass}">${escapeHtml(sub.grade || '—')}</span></td>
            <td class="col-credits"><strong>${escapeHtml(subCredits)}</strong></td>
            <td class="col-result"><span class="${subResultClass}">${escapeHtml(subResult)}</span></td>
          </tr>
        `;
      });

      // Table Wrapper
      const tableHtml = `
        <div class="marksheet-table-wrapper">
          <table class="marksheet-table" aria-label="Semester Examination Results">
            <thead>
              <tr>
                <th class="col-code">SUBJECT CODE</th>
                <th class="col-name">COURSE TITLE</th>
                <th class="col-type">TYPE</th>
                <th class="col-asmt">INTERNAL / CIA<span class="th-sub">OBT / MAX</span></th>
                <th class="col-asmt">MID TERM 1<span class="th-sub">OBT / MAX</span></th>
                <th class="col-asmt">MID TERM 2<span class="th-sub">OBT / MAX</span></th>
                <th class="col-asmt">END TERM<span class="th-sub">OBT / MAX</span></th>
                <th class="col-total-obt">TOTAL OBT</th>
                <th class="col-max">MAX</th>
                <th class="col-gp">GP</th>
                <th class="col-grade">GRADE</th>
                <th class="col-credits">CREDITS</th>
                <th class="col-result">RESULT</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
          
          <!-- Table Footer Summary Bar -->
          <div class="table-summary-bar">
            <div class="summary-bar-tag">
              <span class="tag-icon">📊</span>
              <span>SEMESTER ${semNum} SUMMARY</span>
            </div>
            <div class="summary-bar-metrics">
              <div class="metric-item">
                <span class="metric-k">SGPA:</span>
                <span class="metric-v highlight">${sem.sgpa || '—'}</span>
              </div>
              <div class="metric-item">
                <span class="metric-k">MARKS:</span>
                <span class="metric-v">${sem.obtainedMarks !== undefined ? sem.obtainedMarks : '—'} / ${sem.totalMarks || '—'}</span>
              </div>
              <div class="metric-item">
                <span class="metric-k">CREDITS:</span>
                <span class="metric-v">${sem.creditsEarned !== undefined ? sem.creditsEarned : '—'} / ${sem.credits || '—'}</span>
              </div>
              <div class="metric-item">
                <span class="metric-k">STATUS:</span>
                <span class="${statusPillClass}">${escapeHtml(semStatus)}</span>
              </div>
            </div>
          </div>
        </div>
      `;

      semSec.innerHTML = `
        ${semHeaderHtml}
        ${tableHtml}
      `;

      semestersContainer.appendChild(semSec);
    });
  }

  function handleTabClick(tabKey) {
    if (currentTab === tabKey) return;
    setActiveTabButton(tabKey);
    renderMarksheetTables(cachedSemesters, tabKey);
  }

  function returnToDashboard() {
    ++activeRequestId;
    if (activeFetchController) {
      try { activeFetchController.abort(); } catch (_) {}
      activeFetchController = null;
    }
    stopPolling();
    clearResultView();

    document.querySelector('.app-main')?.classList.remove('results-mode');
    if (currentSession) {
      fetch(`/api/automation/${currentSession.sessionId}/close`, {
        method: 'POST',
        headers: { 'x-session-token': currentSession.sessionToken }
      }).catch(() => {});
      currentSession = null;
    }

    resultSection.classList.add('hidden');
    headerActions.classList.add('hidden');
    progressCard.classList.add('hidden');
    errorCard.classList.add('hidden');
    dashboardSection.classList.remove('hidden');

    resetFetchButton();
    isSubmitting = false;
    studentNumberInput.focus();
  }

  // ============================================================================
  // Event Listeners
  // ============================================================================

  studentNumberInput.addEventListener('input', () => {
    clearInputError();
    updateClearButton();
  });

  inputClearBtn.addEventListener('click', () => {
    studentNumberInput.value = '';
    clearInputError();
    updateClearButton();
    studentNumberInput.focus();
  });

  fetchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    const validation = validateInput(studentNumberInput.value);
    if (!validation.valid) {
      showInputError(validation.message);
      return;
    }

    // Monotonically increase request ID to invalidate any prior in-flight requests or polls
    const currentRequestId = ++activeRequestId;

    // Abort previous in-flight HTTP request if any
    if (activeFetchController) {
      try { activeFetchController.abort(); } catch (_) {}
    }
    activeFetchController = new AbortController();

    // Stop previous polling and wipe result DOM immediately
    stopPolling();
    clearResultView();

    isSubmitting = true;
    setFetchButtonLoading();
    clearInputError();
    errorCard.classList.add('hidden');

    setProgressState(10, 'Initializing workflow...', 1);

    try {
      const res = await fetch('/api/automation/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ studentNumber: validation.value }),
        signal: activeFetchController.signal
      });

      // If a newer submission occurred while this request was in flight, ignore response
      if (currentRequestId !== activeRequestId) return;

      const json = await res.json();
      if (currentRequestId !== activeRequestId) return;

      if (!res.ok || !json.success) {
        showWorkflowError(json.error?.message || 'Failed to start examination retrieval workflow.');
        return;
      }

      if (json.status === 'error' && json.error) {
        showWorkflowError(json.error.message);
        return;
      }

      // Security check: verify returned student matches
      if (json.data?.studentIdentifier && json.data.studentIdentifier !== validation.value) {
        showWorkflowError(`Security Alert: Received data for student ${json.data.studentIdentifier} when requesting ${validation.value}.`);
        return;
      }

      currentSession = {
        sessionId: json.sessionId,
        sessionToken: json.sessionToken,
        studentNumber: validation.value,
        studentName: json.data?.resultData?.student?.name || null
      };

      if ((json.status === 'ready' || json.status === 'download_ready') && json.data) {
        setProgressState(100, 'Examination result loaded successfully.', 7);
        transitionToResultView(json.data, validation.value, currentRequestId);
        return;
      }

      // Begin polling status with requestId and target student
      startPolling(json.sessionId, json.sessionToken, validation.value, currentRequestId);

    } catch (err) {
      if (currentRequestId !== activeRequestId) return;
      if (err.name === 'AbortError') return;
      showWorkflowError(`Network connection error: ${err.message}`);
    }
  });

  // Tab switcher listeners
  if (tabBtnAll) {
    tabBtnAll.addEventListener('click', () => handleTabClick('all'));
  }
  if (tabBtnSem1) {
    tabBtnSem1.addEventListener('click', () => handleTabClick('1'));
  }
  if (tabBtnSem2) {
    tabBtnSem2.addEventListener('click', () => handleTabClick('2'));
  }

  // Navigation action buttons
  closeSessionBtn.addEventListener('click', returnToDashboard);
  headerNewSearchBtn.addEventListener('click', returnToDashboard);

  errorRetryBtn.addEventListener('click', () => {
    errorCard.classList.add('hidden');
    studentNumberInput.focus();
  });

  updateClearButton();
})();
