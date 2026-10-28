# Examination Result Retrieval & PDF Download Automation Platform

> **A production-ready full-stack automation platform designed to eliminate repetitive manual examination marksheet retrieval and PDF downloads from the college educational portal.**

---

## 1. Problem Statement & Architecture

In educational administration, accessing semester examination marksheet records for students is a time-consuming manual process:
1. Navigating to the student portal login page.
2. Manually entering credentials.
3. Handling hash navigation and role redirection.
4. Navigating to the examination results section.
5. Locating the annual / semester marksheet table.
6. Triggering the official PDF export and saving the document.

This platform automates the entire workflow from end to end using the **Student Lookup API**:

```
[ User Browser Client ]
        │
        ▼ 1. Submits 10-digit student identifier (e.g. 9599099932)
[ Express Backend (exam-result-automation) ]
        │
        ├─► 2. Calls Single Student Lookup API:
        │      POST https://student-lookup-portal.vercel.app/api/lookup
        │      Headers:
        │        Authorization: Bearer <STUDENT_LOOKUP_API_KEY>
        │        Content-Type: application/json
        │      Body:
        │        { "studentNumber": "9599099932" }
        │      Returns:
        │        { "success": true, "username": "...", "password": "..." }
        │
        ▼ 3. Launches Isolated Playwright Session (Google Chrome / Edge)
        │
        ├─► 4. Navigates to Login: https://ai-edunova.abes.ac.in/#/auth/login
        │      Switches to "With Password", types username & password, submits login.
        │
        ├─► 5. Intercepts authenticated session:
        │      Redirects to https://ai-edunova.abes.ac.in/#/insync/dashboard/home
        │
        ├─► 6. Navigates to Target Results Page:
        │      https://ai-edunova.abes.ac.in/#/insync/dashboard/exam/semester-examination-result?examMpId=2&resultView=annual
        │
        ├─► 7. Hides Portal Top Navigation Bar:
        │      Injects stylesheet suppressing app-topbar, .layout-topbar, nav.p-breadcrumb, etc.
        │
        ├─► 8. Serves High-Fidelity Results View to Client
        │
        ▼ 9. User clicks dedicated "Download PDF" Button:
              Playwright clicks the portal's native "Download PDF" / "Annual PDF" button,
              intercepts the browser download event, validates the PDF header (%PDF),
              and streams the official marksheet to the user.
```

---

## 2. Key Features

- **Single Student Lookup API Integration**: Connects to `https://student-lookup-portal.vercel.app/api/lookup` to resolve student identifiers directly to username and password with a single HTTP POST request.
- **Headless Browser Automation (Playwright)**: Utilizes Playwright to control system Google Chrome / Microsoft Edge, reliably managing Angular hash navigation (`#/auth/login` and `#/insync/dashboard/...`).
- **Authentic Portal Interface**: Displays the real results interface without fabricating data.
- **Top Navigation Bar Hidden**: Hides `<app-topbar>`, `.layout-topbar`, and `nav.p-breadcrumb` so users see only the relevant marksheet content without portal chrome.
- **Custom "Download PDF" Action**: A dedicated prominent button in the application control header that triggers the portal's original PDF download functionality, verifies the file integrity (%PDF magic bytes), and streams it to the client.
- **Robust Session Isolation**: Every request runs in an isolated `browser.newContext()` with unique UUID session identifiers and cryptographic tokens. No cookies or storage are shared between users.
- **Comprehensive Error Handling**: Handles unconfigured APIs, offline modes, invalid numbers, authentication timeouts, and unpublished results gracefully.
- **Automatic Resource Cleanup**: Periodic sweepers close browser contexts and unlink temporary downloaded files after a configurable TTL (default: 10 minutes) or on explicit session closure.

---

## 3. Real-World Portal Integration Details

During live inspection and verification against `https://ai-edunova.abes.ac.in`:

| Element | Portal Selector / Behavior |
| :--- | :--- |
| **Login URL** | `https://ai-edunova.abes.ac.in/#/auth/login` |
| **Auth Mode Toggle** | `text="With Password"` |
| **Username Input** | `input[placeholder="Enter your username"]` |
| **Password Input** | `input[placeholder="Enter your password"]` |
| **Login Submit** | `button.p-button:has-text("Login")` |
| **Auth Success** | Navigation to `#/insync/dashboard/home` and state `authState="loggedIn"` |
| **Results URL** | `https://ai-edunova.abes.ac.in/#/insync/dashboard/exam/semester-examination-result?examMpId=2&resultView=annual` |
| **Topbar Elements Hidden** | `app-topbar`, `.layout-topbar`, `nav.p-breadcrumb`, `button.layout-menu-button` |
| **PDF Download Control** | `button:has-text("Download PDF")`, `button:has-text("Annual PDF")` |
| **PDF Mechanism** | Triggers jsPDF `triggerBlobDownload` -> creates temporary `<a>` -> fires standard browser download event |

---

## 4. Installation & Prerequisites

### Prerequisites
- **Node.js**: v18.0.0 or higher (v24.x tested)
- **Web Browser**: Google Chrome or Microsoft Edge installed on the host operating system.

### Installation

1. Navigate to the project directory:
   ```bash
   cd exam-result-automation
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables:
   ```bash
   cp .env.example .env
   ```

---

## 5. Environment Variables Reference

| Variable | Required | Default | Description |
| :--- | :---: | :--- | :--- |
| `PORT` | No | `5050` | Port for the Express application server |
| `NODE_ENV` | No | `development` | Environment mode (`development`, `production`, `test`) |
| `STUDENT_LOOKUP_API_URL` | Yes | `https://student-lookup-portal.vercel.app/api/lookup` | Single Student Lookup API endpoint |
| `STUDENT_LOOKUP_API_KEY` | Yes | Bearer Token | Authorized Bearer token for Student Lookup API |
| `PORTAL_LOGIN_URL` | No | `https://ai-edunova.abes.ac.in/#/auth/login` | Educational portal login URL |
| `PORTAL_RESULTS_URL` | No | `https://ai-edunova.abes.ac.in/#/insync/dashboard/exam/semester-examination-result?examMpId=2&resultView=annual` | Annual semester examination results URL |
| `CHROME_PATH` | No | Auto-detected | Absolute path to Chrome/Edge executable |
| `HEADLESS` | No | `true` | Run browser in headless mode |
| `SESSION_TTL_MS` | No | `600000` (10 min) | Session lifetime before automatic cleanup |
| `MAX_CONCURRENT_SESSIONS` | No | `10` | Maximum simultaneous browser sessions |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` (1 min) | Sliding rate-limiting window |
| `RATE_LIMIT_MAX_REQUESTS` | No | `30` | Maximum requests per IP per window |

---

## 6. Running the Application

### Start Development Server
```bash
npm run dev
```

### Start Production Server
```bash
npm start
```
The application will be accessible at: `http://localhost:5050`

---

## 7. Running the Test Suite

The platform includes an automated test suite covering input validation, upstream mock responses, session isolation, ownership enforcement, rate limiting, and PDF verification:

```bash
npm test
```

### Test Coverage Summary:
- **`tests/validation.test.js`**: 10-digit numeric enforcement, rejection of invalid/empty input, strict preservation of leading zeros.
- **`tests/credentials.test.js`**: Single Student Lookup API POST request with `Authorization: Bearer <token>`, mock modes, upstream 401/403/404 handling, timeout recovery, validation of non-empty username/password.
- **`tests/sessionManager.test.js`**: Cryptographic session tokens, cross-session isolation, temporary folder deletion upon session termination.
- **`tests/rateLimiter.test.js`**: Request throttling, 429 status code emission, `Retry-After` header verification.
- **`tests/apiEndpoints.test.js`**: HTTP contracts for `/start`, `/status`, `/view`, and error sanitization.
- **`tests/pdfDownload.test.js`**: PDF binary validation (`%PDF` header verification) and secure file streaming.

---

## 8. API Contract Reference

### 1. `POST /api/automation/start`
Initializes a new examination retrieval session.
- **Request Body**:
  ```json
  { "studentNumber": "9599099932" }
  ```
- **Response** (`202 Accepted`):
  ```json
  {
    "success": true,
    "sessionId": "a1b2c3d4-...",
    "sessionToken": "64_char_hex_token...",
    "status": "started"
  }
  ```

### 2. `GET /api/automation/status/:sessionId`
Returns the real-time stage of the workflow.
- **Headers**: `x-session-token: <sessionToken>`
- **Response** (`200 OK`):
  ```json
  {
    "success": true,
    "data": {
      "sessionId": "a1b2c3d4-...",
      "status": "ready",
      "stage": 7,
      "stageMessage": "Ready to download examination result.",
      "progressPercent": 100,
      "hasRenderedView": true,
      "examSummary": {
        "title": "ABES Engineering College : Annual Result",
        "isPending": false,
        "isPdfButtonDisabled": false
      }
    }
  }
  ```

### 3. `GET /api/automation/view/:sessionId?token=<sessionToken>`
Renders the authenticated portal examination result page with the top navigation bar hidden.

### 4. `POST /api/automation/:sessionId/download`
Triggers the portal's native PDF download, captures and validates the PDF document.
- **Headers**: `x-session-token: <sessionToken>`
- **Response** (`200 OK`):
  ```json
  {
    "success": true,
    "fileName": "Annual_Exam_Result_Akshay.pdf",
    "size": 154820,
    "downloadUrl": "/api/automation/:sessionId/file?token=<sessionToken>"
  }
  ```

### 5. `GET /api/automation/:sessionId/file?token=<sessionToken>`
Securely streams the verified PDF document to the user.

### 6. `POST /api/automation/:sessionId/close`
Closes the browser context and purges all temporary files.

---

## 9. Security & Privacy Guarantees

1. **Server-Side Only Credentials**: Passwords and session cookies are never transmitted to the browser client or stored in `localStorage`.
2. **Session Ownership Enforcement**: Every session action requires a 256-bit cryptographically random token (`x-session-token`), preventing ID enumeration attacks.
3. **No Credential Logging**: Plaintext passwords and Bearer tokens are explicitly omitted from console output and log files.
4. **Temporary Directory Sandboxing**: Each session writes temporary files into a dedicated isolated subdirectory that is purged upon session completion or TTL expiration.
5. **PDF Magic Byte Validation**: Downloaded files are verified to ensure they begin with the `%PDF` file header before being served to users.

---

## 10. High-Concurrency Architecture & Browser Pool (50–100 Concurrent Users)

To reliably support 50–100 simultaneous student submissions and eliminate Vercel serverless launch failures, the platform implements a dual-tier architecture:

### 1. Pre-Warmed Managed Browser Pool (`src/services/browserPool.js`)
- **Multi-Context Reuse**: Instead of spawning a heavy, separate Chromium process for every incoming request (which exhausts RAM and causes `spawn ETXTBSY` / `Operation timed out`), the service maintains a pool of 1–2 long-lived Chromium instances.
- **Ephemeral Context Isolation**: Each student request leases an isolated `browser.newContext()` and `context.newPage()`. Storage, session tokens, cookies, and cache are completely separated between users. Upon completion, the context is closed while the parent Chromium process stays alive.
- **ETXTBSY & Extraction Protection**: A module-level extraction lock ensures that `/tmp/chromium` is inflated once, checked for full expansion (>180MB), given executable permissions (`0o755`), and backed by an exponential retry backoff if the OS write handle is momentarily busy.
- **Serverless Execution Window**: On serverless platforms (Vercel / AWS Lambda), the initial request connection is held open for up to 45 seconds (within Vercel's 60s limit). This prevents the serverless container from freezing CPU mid-automation and returns the finalized marksheet and PDF base64 directly in the initial HTTP response.

### 2. Deployment Modes
* **Alternative Approach (Optimized In-Process Serverless)**: Default zero-cost configuration on Vercel. Chromium runs in-process with bounded context concurrency and pre-warmed pooling.
* **Option A (Persistent Worker Service Delegation)**: Set `WORKER_SERVICE_URL` (and optional `WORKER_API_KEY`) in Vercel environment variables. The Vercel function acts as an ultra-fast proxy (via keep-alive HTTP agents) delegating headless browser execution to a dedicated persistent worker host (e.g. Render, Railway, EC2, VPS), completely bypassing serverless limits.

<!-- Deployment trigger: pre-warmed browser pool and worker proxy architecture -->

