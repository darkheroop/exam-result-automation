# Test Infrastructure Specification — Exam Result Automation

## 1. Overview & Opaque-Box Testing Philosophy

The testing infrastructure for `exam-result-automation` is engineered on the principle of **Opaque-Box Testing** (Black-Box / Behavioral Testing). Under this philosophy:
- Test suites interact with the system strictly through its observable boundaries: DOM elements, HTTP request/response payloads, browser event lifecycles, and public API interfaces.
- Tests assert system behavior, security invariants, data isolation, and user experience contracts rather than coupling to internal implementation mechanics.
- Invariants must hold regardless of refactoring, minification, comment removal, or algorithmic optimizations.
- Zero "facade" or trivial tests: every assertion exercises authentic logic with explicit, verifiable expected values.

The project utilizes the native **Node.js test runner (`node:test`)** and strict assertion library (`node:assert/strict`) across all unit, integration, and end-to-end suites, guaranteeing zero external test runtime dependencies and deterministic execution.

---

## 2. 4-Tier Test Methodology

The testing architecture organizes all test coverage across four rigorous verification tiers:

```
┌────────────────────────────────────────────────────────────────────────┐
│  Tier 4: Real-World Scenarios & Security Abuse Cases                   │
│  (End-to-End attack simulations, brute force, timing, SSE lifecycle)   │
├────────────────────────────────────────────────────────────────────────┤
│  Tier 3: Pairwise & Combinatorial Testing                              │
│  (Keyboard modifiers, header permutations, auth state combinations)    │
├────────────────────────────────────────────────────────────────────────┤
│  Tier 2: Boundary Value Analysis (BVA)                                 │
│  (Rate limit thresholds, window delta triggers, cooldown timers, len)  │
├────────────────────────────────────────────────────────────────────────┤
│  Tier 1: Category-Partition (Equivalence Partitioning)                 │
│  (Valid vs invalid inputs, shortcut categories, placeholder states)    │
└────────────────────────────────────────────────────────────────────────┘
```

### Tier 1: Category-Partition (Equivalence Partitioning)
Partitions the system inputs, user actions, and client/server states into non-overlapping equivalence classes where each class yields an identical behavioral response:
- **Search Identifiers**:
  - Class A (Valid): Exact 10-digit numeric string (e.g., `8887416471`, `0012345678` with leading zeros preserved).
  - Class B (Invalid Length): `<10` digits (9-digit, 1-digit) or `>10` digits (11-digit, 12-digit).
  - Class C (Invalid Characters): Alphanumeric, special characters, whitespace-only, empty string.
  - Class D (Type Violations): Non-string types (`null`, `undefined`, objects, numbers).
- **Inspection Vectors**:
  - Class A (DevTools Shortcuts): `F12`, `Ctrl+Shift+I`, `Cmd+Option+I`, `Ctrl+Shift+J`, `Cmd+Option+J`, `Ctrl+Shift+C`.
  - Class B (Source / Network / Console Inspection): `Ctrl+U`, `Ctrl+Shift+K`, `Ctrl+Shift+E`, `Ctrl+S`.
  - Class C (Mouse Vectors): Right-click `contextmenu` event.
  - Class D (Standard User Operations): Plain alphanumeric typing, Enter, Tab, Backspace, Arrow keys.
- **Admin Authentication**:
  - Class A (Valid Credentials): Correct username and password configured in environment.
  - Class B (Invalid Password): Correct username, incorrect password.
  - Class C (Invalid Username): Non-existent username, random string.
  - Class D (Empty / Malformed): Empty username, empty password, missing fields, non-JSON body.

### Tier 2: Boundary Value Analysis (BVA)
Identifies and exercises critical threshold boundaries, transition points, and off-by-one conditions:
- **Rate Limiter Thresholds**:
  - Boundary: 5 failed attempts per 15-minute window per IP/user.
  - Test points: 1st attempt (allowed), 4th attempt (allowed), 5th attempt (allowed), 6th attempt (locked out with HTTP 429), reset at $t = \text{windowMs} + 1\text{ms}$ (allowed).
- **DevTools Dimension Delta**:
  - Threshold: 160px delta between outer and inner window dimensions (`window.outerWidth - window.innerWidth > 160` or `window.outerHeight - window.innerHeight > 160`).
  - Test points: $\Delta = 0\text{px}$ (nominal), $\Delta = 159\text{px}$ (no detection), $\Delta = 160\text{px}$ (boundary), $\Delta = 161\text{px}$ (detection triggered).
- **Security Modal Anti-Spam Throttle**:
  - Threshold: 1500ms cooldown window.
  - Test points: Trigger at $t = 0\text{ms}$ (modal shown), second trigger at $t = 100\text{ms}$ (suppressed / single modal), third trigger at $t = 1499\text{ms}$ (suppressed), trigger at $t = 1501\text{ms}$ (allowed).
- **Timing Differentiation (Side-Channel)**:
  - Threshold: Username check timing must not differ significantly between matching vs non-matching usernames.
  - Verification: Verification latency variance must remain strictly bounded across valid vs invalid user probes.

### Tier 3: Combinatorial & Pairwise Testing
Tests combinations of orthogonal factors to verify absence of feature interference and unwanted masking:
- **Keyboard Shortcut Modifier Matrix**:
  - `(Ctrl / Cmd) × (Shift / Alt / None) × (Key: C, V, A, X, I, J, U, K, E, S)`
  - Crucial distinction: `Ctrl + C` (Copy $\rightarrow$ Allowed) vs `Ctrl + Shift + C` (Element Picker $\rightarrow$ Blocked).
  - Crucial distinction: `Ctrl + A` (Select All $\rightarrow$ Allowed) vs `Ctrl + Shift + I` (Inspect $\rightarrow$ Blocked).
  - Crucial distinction: `Ctrl + V` (Paste $\rightarrow$ Allowed) vs `Ctrl + U` (View Source $\rightarrow$ Blocked).
- **Authentication Source Matrix**:
  - Cookie Header $\times$ Authorization Header $\times$ JSON Body.
  - Ensures HttpOnly cookie takes precedence, token is stripped from response body, and headers without cookie are rejected where appropriate.
- **Input Sanitization × View Modes**:
  - Public Portal (`index.html`) $\times$ Admin Login (`admin/login.html`) $\times$ Admin SPA (`admin/index.html`).
  - Asserts no placeholder in any form control across any page leaks example numbers, sample names, or usernames.

### Tier 4: Real-World Scenarios & Security Abuse Cases
Simulates adversarial and end-to-end production scenarios:
- **Brute-Force Dictionary Attack**: Consecutive automated POST requests simulating a credential stuffing attack, verifying lockouts and memory-safe cache eviction.
- **Timing Attack / Username Enumeration**: Automated statistical timing probe measuring response duration across varying username lengths and existences.
- **Active Inspection Deterrence During Search**: Triggering F12 or context menu during active search execution; verifies security warning modal appears while preserving the search operation.
- **Clipboard & Data Export Flow**: User copying retrieved student marksheet details using keyboard shortcuts (`Ctrl+C`); verifies clipboard data is preserved and not intercepted.
- **Full Comment & Example Purge Verification**: Deep structural scan across all frontend and backend source files verifying total absence of development comments and test fixtures.

---

## 3. Feature Inventory & Test Mapping

The 17 architectural features identified in `PROJECT.md` are systematically covered across existing suites and the three new E2E verification suites:

| # | Feature Name | Milestone | Primary Test Suite | Methodology Tiers |
|---|--------------|-----------|--------------------|-------------------|
| 1 | Neutralize Placeholder Examples | M1 | `tests/e2eSanitization.test.js` | Tier 1, Tier 3 |
| 2 | Remove Input Hints & Guidance | M1 | `tests/e2eSanitization.test.js` | Tier 1 |
| 3 | Remove Info & Architecture Blocks | M1 | `tests/e2eSanitization.test.js` | Tier 1, Tier 4 |
| 4 | Minimal Search Loading State | M1 | `tests/e2eSanitization.test.js` | Tier 1, Tier 4 |
| 5 | Anti-Inspection Event Interception | M2 | `tests/e2eAntiInspection.test.js` | Tier 1, Tier 3 |
| 6 | DevTools Opening Detection | M2 | `tests/e2eAntiInspection.test.js` | Tier 2, Tier 4 |
| 7 | Security Warning Alert Popup | M2 | `tests/e2eAntiInspection.test.js` | Tier 2, Tier 4 |
| 8 | Input & Clipboard Preservation | M2 | `tests/e2eAntiInspection.test.js` | Tier 1, Tier 3 |
| 9 | Constant-Time Admin Auth | M3 | `tests/e2eAdminSecurity.test.js` | Tier 2, Tier 4 |
| 10 | Brute-Force Rate Limiting & Lockout | M3 | `tests/e2eAdminSecurity.test.js` | Tier 2, Tier 4 |
| 11 | Session Token & Cookie Hardening | M3 | `tests/e2eAdminSecurity.test.js` | Tier 1, Tier 3 |
| 12 | Performance & Bug Optimization | M3 | `tests/e2eAdminSecurity.test.js` | Tier 2, Tier 4 |
| 13 | Frontend Comment Removal | M4 | `tests/e2eSanitization.test.js` | Tier 1, Tier 4 |
| 14 | Backend Comment Removal | M4 | `tests/e2eSanitization.test.js` | Tier 1, Tier 4 |
| 15 | Backend Example & Secret Sanitization | M4 | `tests/e2eSanitization.test.js` | Tier 1, Tier 4 |
| 16 | Admin File Synchronization | M1, M2, M4 | `tests/adminFrontend.test.js`, `tests/adminPageDataRetrieval.test.js`, `tests/e2eSanitization.test.js` | Tier 1 |
| 17 | E2E & Existing Test Preservation | M5 | Full test suite execution (`node --test tests/**/*.test.js`) | All Tiers |

---

## 4. Test Execution & Verification

### Running the Complete Test Suite
```bash
npm test
```
*Equivalent command:*
```bash
node --test tests/**/*.test.js
```

### Running Specific Test Suites
```bash
# E2E Sanitization Suite
node --test tests/e2eSanitization.test.js

# E2E Anti-Inspection Suite
node --test tests/e2eAntiInspection.test.js

# E2E Admin Security Suite
node --test tests/e2eAdminSecurity.test.js
```

### Execution Invariants & Quality Gates
1. **Zero Regressions**: All 149 existing tests across 31 files must remain 100% passing.
2. **Zero Facade Assertions**: Every assertion must test authentic contract conditions.
3. **Deterministic Performance**: Total test suite execution time must complete within 35 seconds.
4. **Isolated State**: Every test suite manages its own state, cleaning up database records and mock environments.
