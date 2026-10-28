/**
 * Educational Examination Result Retrieval & PDF Download Automation Client
 */

(() => {
  'use strict';

  // State
  let currentSession = null;
  let statusPollTimer = null;
  let isSubmitting = false;
  let isDownloading = false;

  // DOM Elements
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
  const portalViewFrame = document.getElementById('portalViewFrame');
  const downloadAlert = document.getElementById('downloadAlert');
  const downloadAlertTitle = document.getElementById('downloadAlertTitle');
  const downloadAlertMessage = document.getElementById('downloadAlertMessage');
  const closeAlertBtn = document.getElementById('closeAlertBtn');
  const pendingResultAlert = document.getElementById('pendingResultAlert');

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
    fetchResultBtn.disabled = false;
    fetchResultBtn.querySelector('.btn-text').textContent = 'Fetch Result';
    fetchResultBtn.querySelector('.btn-spinner').classList.add('hidden');
  }

  function setFetchButtonLoading() {
    fetchResultBtn.disabled = true;
    fetchResultBtn.querySelector('.btn-text').textContent = 'Processing...';
    fetchResultBtn.querySelector('.btn-spinner').classList.remove('hidden');
  }

  // ============================================================================
  // Polling Status
  // ============================================================================

  function startPolling(sessionId, sessionToken) {
    stopPolling();
    let consecutiveErrors = 0;

    statusPollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/automation/status/${sessionId}`, {
          headers: {
            'x-session-token': sessionToken,
            'Accept': 'application/json'
          }
        });

        if (!res.ok) {
          consecutiveErrors++;
          // Give serverless functions up to 5 consecutive attempts (~6 seconds) during cold starts/switches
          if (consecutiveErrors <= 5) {
            return;
          }
          const errData = await res.json().catch(() => ({}));
          showWorkflowError(errData.error?.message || 'Unable to check automation status.');
          return;
        }

        consecutiveErrors = 0;
        const json = await res.json();
        const data = json.data;

        if (!data) return;

        if (data.status === 'error') {
          showWorkflowError(data.error?.message || 'Automation workflow failed.');
          return;
        }

        setProgressState(data.progressPercent, data.stageMessage, data.stage);

        if (data.status === 'ready' || data.status === 'download_ready') {
          stopPolling();
          transitionToResultView(data);
        }
      } catch (err) {
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
  // Transition to Result Screen
  // ============================================================================

  function transitionToResultView(sessionData) {
    isSubmitting = false;
    resetFetchButton();

    dashboardSection.classList.add('hidden');
    resultSection.classList.remove('hidden');
    headerActions.classList.remove('hidden');

    resultStudentId.textContent = currentSession.studentNumber;
    resultSemesterTitle.textContent = sessionData.examSummary?.title || 'Annual Semester Examination Result';

    // Check if the result is unpublished / pending
    if (sessionData.examSummary?.isPending) {
      pendingResultAlert.classList.remove('hidden');
    } else {
      pendingResultAlert.classList.add('hidden');
    }

    // Load rendered portal view in iframe with session token
    const viewUrl = `/api/automation/view/${currentSession.sessionId}?token=${encodeURIComponent(currentSession.sessionToken)}`;
    portalViewFrame.src = viewUrl;
  }

  function returnToDashboard() {
    stopPolling();
    if (currentSession) {
      // Call close endpoint in background
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

    portalViewFrame.src = 'about:blank';
    resetFetchButton();
    isSubmitting = false;
    studentNumberInput.focus();
  }

  // ============================================================================
  // PDF Download Handling
  // ============================================================================

  async function handleDownloadPdf() {
    if (!currentSession || isDownloading) return;

    isDownloading = true;
    setDownloadButtonsLoading(true);
    downloadAlert.classList.add('hidden');

    try {
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
        alert(`Download Notice: ${errorMsg}`);
        return;
      }

      // Trigger actual browser file download
      const downloadLink = document.createElement('a');
      downloadLink.href = json.downloadUrl;
      downloadLink.download = json.fileName || 'Examination_Result.pdf';
      document.body.appendChild(downloadLink);
      downloadLink.click();
      document.body.removeChild(downloadLink);

      // Display verified success notification
      const fileSizeKb = json.size ? ` (${Math.round(json.size / 1024)} KB)` : '';
      downloadAlertTitle.textContent = 'Official PDF Download Verified & Complete';
      downloadAlertMessage.textContent = `Retrieved "${json.fileName}"${fileSizeKb} directly from the educational portal.`;
      downloadAlert.classList.remove('hidden');

    } catch (err) {
      alert(`Network error while downloading PDF: ${err.message}`);
    } finally {
      isDownloading = false;
      setDownloadButtonsLoading(false);
    }
  }

  function setDownloadButtonsLoading(loading) {
    const btns = [actionDownloadBtn, headerDownloadBtn];
    btns.forEach(btn => {
      if (!btn) return;
      btn.disabled = loading;
      const text = btn.querySelector('.btn-text');
      const spinner = btn.querySelector('.btn-spinner');
      if (text) text.textContent = loading ? 'Downloading...' : 'Download PDF';
      if (spinner) {
        if (loading) spinner.classList.remove('hidden');
        else spinner.classList.add('hidden');
      }
    });
  }

  // ============================================================================
  // Event Listeners
  // ============================================================================

  // Input events
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

  // Form submission
  fetchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    const validation = validateInput(studentNumberInput.value);
    if (!validation.valid) {
      showInputError(validation.message);
      return;
    }

    isSubmitting = true;
    setFetchButtonLoading();
    clearInputError();
    errorCard.classList.add('hidden');

    // Show initial progress state
    setProgressState(10, 'Initializing workflow...', 1);

    try {
      const res = await fetch('/api/automation/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ studentNumber: validation.value })
      });

      const json = await res.json();

      if (!res.ok || !json.success) {
        showWorkflowError(json.error?.message || 'Failed to start examination retrieval workflow.');
        return;
      }

      currentSession = {
        sessionId: json.sessionId,
        sessionToken: json.sessionToken,
        studentNumber: validation.value
      };

      // Begin polling status
      startPolling(json.sessionId, json.sessionToken);

    } catch (err) {
      showWorkflowError(`Network connection error: ${err.message}`);
    }
  });

  // Action buttons
  actionDownloadBtn.addEventListener('click', handleDownloadPdf);
  headerDownloadBtn.addEventListener('click', handleDownloadPdf);

  closeSessionBtn.addEventListener('click', returnToDashboard);
  headerNewSearchBtn.addEventListener('click', returnToDashboard);

  errorRetryBtn.addEventListener('click', () => {
    errorCard.classList.add('hidden');
    studentNumberInput.focus();
  });

  closeAlertBtn.addEventListener('click', () => {
    downloadAlert.classList.add('hidden');
  });

  // Initial setup
  updateClearButton();
})();
