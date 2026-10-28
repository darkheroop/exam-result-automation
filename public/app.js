/**
 * Educational Examination Result Retrieval & Official Portal Recreation Client
 */

(() => {
  'use strict';

  // State
  let currentSession = null;
  let statusPollTimer = null;
  let isSubmitting = false;
  let isDownloading = false;
  let activeRequestId = 0;
  let activeFetchController = null;

  // DOM Elements - Search & Form
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
  const headerDownloadBtn = document.getElementById('headerDownloadBtn');

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

  // Results View Elements
  const resultStudentId = document.getElementById('resultStudentId');
  const resultSemesterTitle = document.getElementById('resultSemesterTitle');
  const actionDownloadBtn = document.getElementById('actionDownloadBtn');
  const closeSessionBtn = document.getElementById('closeSessionBtn');
  const marksheetAnnualPdfBtn = document.getElementById('marksheetAnnualPdfBtn');
  const downloadAlert = document.getElementById('downloadAlert');
  const downloadAlertTitle = document.getElementById('downloadAlertTitle');
  const downloadAlertMessage = document.getElementById('downloadAlertMessage');
  const closeAlertBtn = document.getElementById('closeAlertBtn');
  const pendingResultAlert = document.getElementById('pendingResultAlert');

  // Recreated Marksheet Elements
  const studName = document.getElementById('studName');
  const studRegnNo = document.getElementById('studRegnNo');
  const studSeatNo = document.getElementById('studSeatNo');
  const studClass = document.getElementById('studClass');
  const studAcadYear = document.getElementById('studAcadYear');
  const studPublishedOn = document.getElementById('studPublishedOn');
  const studSession = document.getElementById('studSession');
  const studAbcId = document.getElementById('studAbcId');
  const studSemesters = document.getElementById('studSemesters');
  const studStatus = document.getElementById('studStatus');
  const studYgpa = document.getElementById('studYgpa');
  const studCredits = document.getElementById('studCredits');
  const studMarks = document.getElementById('studMarks');
  const studCop = document.getElementById('studCop');
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

  function clearResultView() {
    resultStudentId.textContent = '—';
    resultSemesterTitle.textContent = 'Annual Result';
    studName.textContent = '—';
    studRegnNo.textContent = '—';
    studSeatNo.textContent = '—';
    studClass.textContent = '—';
    studAcadYear.textContent = '—';
    studPublishedOn.textContent = '—';
    studSession.textContent = '—';
    studAbcId.textContent = '—';
    studSemesters.textContent = '—';
    studStatus.textContent = '—';
    studYgpa.textContent = '—';
    studCredits.textContent = '—';
    studMarks.textContent = '—';
    studCop.textContent = '—';
    semestersContainer.innerHTML = '';
    portalViewFrame.srcdoc = '';
    iframeContainer.classList.add('hidden');
    pendingResultAlert.classList.add('hidden');
    downloadAlert.classList.add('hidden');
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

    if (currentSession) {
      // Cache PDF base64 if provided
      if (sessionData.pdfBase64) {
        currentSession.pdfBase64 = sessionData.pdfBase64;
      }
      if (sessionData.downloadFileName) {
        currentSession.downloadFileName = sessionData.downloadFileName;
      }
    }

    const result = sessionData.resultData;

    if (result && result.student) {
      // 1. Populate Student Metadata
      studName.textContent = result.student.name || result.student.fullName || '—';
      studRegnNo.textContent = result.student.regnNo || '—';
      studSeatNo.textContent = result.student.seatNo || '—';
      studClass.textContent = result.student.className || '—';
      studAcadYear.textContent = result.student.academicYear || '—';
      studPublishedOn.textContent = result.student.publishedOn || '—';
      studSession.textContent = result.student.session || '—';
      studAbcId.textContent = result.student.abcId || '—';
      studSemesters.textContent = result.student.semesters || '—';
      studStatus.textContent = result.student.status || '—';
      studYgpa.textContent = result.student.ygpa || '—';
      studCredits.textContent = result.student.creditsEarned !== undefined ? result.student.creditsEarned : '—';
      studMarks.textContent = result.student.marks || '—';
      studCop.textContent = result.student.cop || '—';

      // 2. Render Semesters (Semester I & Semester II)
      renderSemesters(result.semesters || []);
      iframeContainer.classList.add('hidden');

      if (result.annualSummary?.status === 'PENDING' || result.student.status === 'PENDING') {
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

  function renderSemesters(semesters) {
    semestersContainer.innerHTML = '';

    if (!semesters || semesters.length === 0) {
      semestersContainer.innerHTML = '<p class="form-hint" style="text-align:center; padding: 2rem;">No semester assessment records found.</p>';
      return;
    }

    semesters.forEach(sem => {
      const semSec = document.createElement('div');
      semSec.className = 'semester-section';

      // Build Summary Cards HTML
      const summaryCardsHtml = `
        <div class="sem-summary-cards">
          <!-- SGPA Card -->
          <div class="summary-metric-card">
            <div class="metric-icon-circle blue-circle">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2">
                <path d="M12 20h9"></path>
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
              </svg>
            </div>
            <div class="metric-body">
              <div class="metric-val-row">
                <span class="metric-large-val">${sem.sgpa || '—'}</span>
                <span class="metric-unit">SGPA</span>
              </div>
              <div class="metric-progress-line blue-line"></div>
            </div>
          </div>

          <!-- Total Marks Card -->
          <div class="summary-metric-card">
            <div class="metric-icon-circle orange-circle">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2">
                <line x1="18" y1="20" x2="18" y2="10"></line>
                <line x1="12" y1="20" x2="12" y2="4"></line>
                <line x1="6" y1="20" x2="6" y2="14"></line>
              </svg>
            </div>
            <div class="metric-body">
              <div class="metric-val-row">
                <span class="metric-large-val">${sem.obtainedMarks !== undefined ? sem.obtainedMarks : '—'}</span>
                <span class="metric-sub-val">/ ${sem.totalMarks || '—'}</span>
              </div>
              <div class="metric-label">Total Marks</div>
              <div class="metric-progress-line orange-line"></div>
            </div>
          </div>

          <!-- Credits Earned Card -->
          <div class="summary-metric-card">
            <div class="metric-icon-circle green-circle">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </div>
            <div class="metric-body">
              <div class="metric-val-row">
                <span class="metric-large-val">${sem.creditsEarned !== undefined ? sem.creditsEarned : '—'}</span>
                <span class="metric-sub-val">/ ${sem.credits || '—'}</span>
              </div>
              <div class="metric-label">Credits Earned</div>
              <div class="metric-progress-line green-line"></div>
            </div>
          </div>
        </div>
      `;

      // Build Table Rows
      let rowsHtml = '';
      (sem.subjects || []).forEach(sub => {
        const isTheory = sub.type === 'THEORY';
        const typeBadge = isTheory ? '<span class="badge-theory">THEORY</span>' : '<span class="badge-lab">LAB</span>';

        const mt1Cell = isTheory && sub.midTerm1
          ? `<div><div class="cell-obt">${sub.midTerm1.obt}</div><div class="cell-sub">/ ${sub.midTerm1.min} / ${sub.midTerm1.max}</div></div>`
          : '<span class="cell-sub">—</span>';

        const mt2Cell = isTheory && sub.midTerm2
          ? `<div><div class="cell-obt">${sub.midTerm2.obt}</div><div class="cell-sub">/ ${sub.midTerm2.min} / ${sub.midTerm2.max}</div></div>`
          : '<span class="cell-sub">—</span>';

        const endTermCell = isTheory && sub.endTerm
          ? `<div><div class="cell-obt">${sub.endTerm.obt}</div><div class="cell-sub">/ ${sub.endTerm.min} / ${sub.endTerm.max}</div></div>`
          : '<span class="cell-sub">—</span>';

        const extCell = sub.external
          ? `<div><div class="cell-obt">${sub.external.obt}</div><div class="cell-sub">/ ${sub.external.min} / ${sub.external.max}</div></div>`
          : '<span class="cell-sub">—</span>';

        const intCell = sub.internal
          ? `<div><div class="cell-obt">${sub.internal.obt}</div><div class="cell-sub">/ ${sub.internal.min} / ${sub.internal.max}</div></div>`
          : '<span class="cell-sub">—</span>';

        const totalCell = sub.total
          ? `<div><div class="cell-total-obt">${sub.total.obt}</div><div class="cell-sub">${sub.total.min} / ${sub.total.max}</div></div>`
          : '<span class="cell-sub">—</span>';

        // Grade Badge styling
        let gradeClass = 'grade-green';
        const g = (sub.grade || '').toUpperCase();
        if (g.includes('A')) gradeClass = 'grade-purple';
        else if (g.includes('B')) gradeClass = 'grade-amber';
        else if (g.includes('C')) gradeClass = 'grade-orange';
        else if (g.includes('F') || g.includes('E#')) gradeClass = 'grade-red';

        const resultClass = sub.result === 'PASS' ? 'pill-pass' : (sub.result === 'PWG' ? 'pill-pwg' : 'pill-fail');

        rowsHtml += `
          <tr>
            <td class="cell-subject">
              <div class="subject-name">${escapeHtml(sub.name || sub.title)}</div>
              <div class="subject-meta">
                <span class="subject-code">${escapeHtml(sub.code)}</span>
                ${typeBadge}
              </div>
            </td>
            <td>${mt1Cell}</td>
            <td>${mt2Cell}</td>
            <td>${endTermCell}</td>
            <td>${extCell}</td>
            <td>${intCell}</td>
            <td>${totalCell}</td>
            <td><strong>${sub.creditsEarned !== undefined ? sub.creditsEarned : sub.credits}</strong></td>
            <td><span class="cell-grade ${gradeClass}">${escapeHtml(sub.grade || '—')}</span></td>
            <td><strong>${sub.gradePoints !== undefined ? sub.gradePoints : '—'}</strong></td>
            <td><strong>${sub.creditGrade !== undefined ? sub.creditGrade : '—'}</strong></td>
            <td><span class="${resultClass}">${escapeHtml(sub.result || 'PASS')}</span></td>
          </tr>
        `;
      });

      const tableHtml = `
        <div class="marksheet-table-wrapper">
          <table class="marksheet-table">
            <thead>
              <tr>
                <th class="col-subject">SUBJECT</th>
                <th class="col-asmt">MID TERM 1<span class="asmt-sub">OBT | MIN | MAX</span></th>
                <th class="col-asmt">MID TERM 2<span class="asmt-sub">OBT | MIN | MAX</span></th>
                <th class="col-asmt">END TERM<span class="asmt-sub">OBT | MIN | MAX</span></th>
                <th class="col-asmt">EXTERNAL<span class="asmt-sub">OBT | MIN | MAX</span></th>
                <th class="col-asmt">INTERNAL<span class="asmt-sub">OBT | MIN | MAX</span></th>
                <th class="col-asmt col-total">SUBJECT TOTAL<span class="asmt-sub">OBT / MIN / MAX</span></th>
                <th class="col-stat">CREDITS EARNED</th>
                <th class="col-stat">GRADE</th>
                <th class="col-stat">GP</th>
                <th class="col-stat">CG</th>
                <th class="col-stat">RESULT</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
          <div class="table-summary-bar">
            <span class="sem-summary-tag">SUMMARY ${(sem.title || '').toUpperCase()}</span>
            <div class="sem-summary-items">
              <span><strong>SGPA:</strong> ${sem.sgpa || '—'}</span>
              <span><strong>CREDITS:</strong> ${sem.creditsEarned !== undefined ? sem.creditsEarned : '—'} / ${sem.credits || '—'}</span>
              <span><strong>TOTAL MARKS:</strong> ${sem.obtainedMarks !== undefined ? sem.obtainedMarks : '—'} / ${sem.totalMarks || '—'}</span>
              <span class="${sem.status === 'PASS' ? 'pill-pass' : 'pill-pwg'}">${sem.status || 'PASS'}</span>
            </div>
          </div>
        </div>
      `;

      semSec.innerHTML = `
        <h2 class="semester-title">${escapeHtml(sem.title)}</h2>
        ${summaryCardsHtml}
        ${tableHtml}
      `;

      semestersContainer.appendChild(semSec);
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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
    downloadAlert.classList.add('hidden');
    progressCard.classList.add('hidden');
    errorCard.classList.add('hidden');
    dashboardSection.classList.remove('hidden');

    resetFetchButton();
    isSubmitting = false;
    studentNumberInput.focus();
  }

  // ============================================================================
  // Official Annual PDF Download Handling
  // ============================================================================

  async function handleDownloadPdf() {
    if (!currentSession || isDownloading) return;

    isDownloading = true;
    setDownloadButtonsLoading(true);
    downloadAlert.classList.add('hidden');

    const downloadBlob = (blob, fileName) => {
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = fileName || `${currentSession.studentName || 'Annual-Result'}-${currentSession.studentNumber}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);

      const fileSizeKb = blob.size ? ` (${Math.round(blob.size / 1024)} KB)` : '';
      downloadAlertTitle.textContent = 'Official Annual PDF Download Complete';
      downloadAlertMessage.textContent = `Downloaded "${link.download}"${fileSizeKb} successfully from official portal.`;
      downloadAlert.classList.remove('alert-warning', 'hidden');
      downloadAlert.classList.add('alert-success');
    };

    try {
      // 1. Fast-path: If PDF base64 is already cached in currentSession, download immediately
      if (currentSession.pdfBase64) {
        const byteCharacters = atob(currentSession.pdfBase64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: 'application/pdf' });
        downloadBlob(blob, currentSession.downloadFileName);
        return;
      }

      // 2. Request backend download endpoint
      const res = await fetch(`/api/automation/${currentSession.sessionId}/download`, {
        method: 'POST',
        headers: {
          'x-session-token': currentSession.sessionToken,
          'Accept': 'application/json'
        }
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok || !json.success) {
        const errorMsg = json.error?.message || 'Could not download examination result PDF.';
        downloadAlertTitle.textContent = 'PDF Download Notice';
        downloadAlertMessage.textContent = errorMsg;
        downloadAlert.classList.remove('alert-success', 'hidden');
        downloadAlert.classList.add('alert-warning');
        return;
      }

      // If backend returned base64 in response:
      if (json.base64) {
        currentSession.pdfBase64 = json.base64;
        currentSession.downloadFileName = json.fileName;
        const byteCharacters = atob(json.base64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: 'application/pdf' });
        downloadBlob(blob, json.fileName);
        return;
      }

      // 3. Download via binary stream fetch
      const fileRes = await fetch(json.downloadUrl);
      if (!fileRes.ok) {
        throw new Error('Failed to retrieve PDF document from server.');
      }
      const blob = await fileRes.blob();
      downloadBlob(blob, json.fileName);

    } catch (err) {
      downloadAlertTitle.textContent = 'PDF Download Notice';
      downloadAlertMessage.textContent = `Unable to complete PDF download: ${err.message}`;
      downloadAlert.classList.remove('alert-success', 'hidden');
      downloadAlert.classList.add('alert-warning');
    } finally {
      isDownloading = false;
      setDownloadButtonsLoading(false);
    }
  }

  function setDownloadButtonsLoading(loading) {
    const btns = [actionDownloadBtn, headerDownloadBtn, marksheetAnnualPdfBtn];
    btns.forEach(btn => {
      if (!btn) return;
      btn.disabled = loading;
      const text = btn.querySelector('.btn-text, span');
      const spinner = btn.querySelector('.btn-spinner');
      if (text) text.textContent = loading ? 'Downloading...' : 'Annual PDF';
      if (spinner) {
        if (loading) spinner.classList.remove('hidden');
        else spinner.classList.add('hidden');
      }
    });
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

  actionDownloadBtn.addEventListener('click', handleDownloadPdf);
  headerDownloadBtn.addEventListener('click', handleDownloadPdf);
  if (marksheetAnnualPdfBtn) {
    marksheetAnnualPdfBtn.addEventListener('click', handleDownloadPdf);
  }

  closeSessionBtn.addEventListener('click', returnToDashboard);
  headerNewSearchBtn.addEventListener('click', returnToDashboard);

  errorRetryBtn.addEventListener('click', () => {
    errorCard.classList.add('hidden');
    studentNumberInput.focus();
  });

  closeAlertBtn.addEventListener('click', () => {
    downloadAlert.classList.add('hidden');
  });

  updateClearButton();
})();
