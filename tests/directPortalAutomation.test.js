'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const app = require('../src/app');
const { AutomationService } = require('../src/services/automationService');
const { SessionManager } = require('../src/services/sessionManager');

function startTestAppServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`
      });
    });
  });
}

function requestJson(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(u, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { if (data) json = JSON.parse(data); } catch {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: json,
          raw: data
        });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

test('Direct Portal Automation - PDF download routes are completely removed (404)', async () => {
  const { server, url } = await startTestAppServer();
  try {
    // 1. Verify POST /:sessionId/download is 404
    const dlRes = await requestJson(`${url}/api/automation/test-session-id/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    assert.equal(dlRes.statusCode, 404);

    // 2. Verify GET /download/:sessionId is 404
    const dlGetRes = await requestJson(`${url}/api/automation/download/test-session-id`);
    assert.equal(dlGetRes.statusCode, 404);

    // 3. Verify GET /:sessionId/file is 404
    const fileRes = await requestJson(`${url}/api/automation/test-session-id/file`);
    assert.equal(fileRes.statusCode, 404);
  } finally {
    server.close();
  }
});

test('Direct Portal Automation - User Identity Verification throws STUDENT_IDENTITY_MISMATCH', async () => {
  const sessionManager = new SessionManager();
  const automationService = new AutomationService({
    sessionManager,
    mockMode: false
  });

  const studentNumber = '8887416471';
  const session = sessionManager.createSession(studentNumber);

  automationService.credentialService = {
    fetchCredentials: async () => ({
      username: 'test_student',
      password: 'test_password',
      studentNumber: studentNumber
    })
  };

  const originalHttpsGet = https.get;
  https.get = function(url, options, callback) {
    const urlStr = typeof url === 'string' ? url : url.href;
    const req = new EventEmitter();
    req.destroy = () => {};

    setImmediate(() => {
      if (urlStr.includes('GetUserAuthenticatedData')) {
        const mockAuthResponse = JSON.stringify({
          collection: {
            response: {
              responseStatus: 'SUCCESS',
              userData: {
                id: '999',
                mobile: '1111111111', // Mismatched mobile!
                firstName: 'Wrong',
                lastName: 'Student'
              }
            }
          }
        });

        const res = new EventEmitter();
        res.statusCode = 200;
        res.setEncoding = () => {};
        callback(res);
        res.emit('data', mockAuthResponse);
        res.emit('end');
      }
    });

    return req;
  };

  try {
    await assert.rejects(
      async () => {
        await automationService.runWorkflow(session.sessionId, session.sessionToken, studentNumber);
      },
      (err) => {
        assert.equal(err.code, 'STUDENT_IDENTITY_MISMATCH');
        assert.match(err.message, /Student identity mismatch/);
        return true;
      }
    );

    const updatedSession = sessionManager.getSession(session.sessionId, session.sessionToken);
    assert.equal(updatedSession.status, 'error');
    assert.equal(updatedSession.error.code, 'STUDENT_IDENTITY_MISMATCH');
  } finally {
    https.get = originalHttpsGet;
  }
});

test('Direct Portal Automation - MD5 password hashing, header verification, and clean result normalization', async () => {
  const sessionManager = new SessionManager();
  const automationService = new AutomationService({
    sessionManager,
    mockMode: false
  });

  const studentNumber = '8887416471';
  const plainPassword = 'mySecretPassword';
  const expectedMd5 = crypto.createHash('md5').update(plainPassword).digest('hex');
  const session = sessionManager.createSession(studentNumber);

  automationService.credentialService = {
    fetchCredentials: async () => ({
      username: 'ansh14',
      password: plainPassword,
      studentNumber: studentNumber
    })
  };

  let capturedAuthPayload = null;
  let capturedAuthHash = null;
  let capturedExamPayload = null;
  let capturedExamHash = null;

  const originalHttpsGet = https.get;
  https.get = function(url, options, callback) {
    const urlStr = typeof url === 'string' ? url : url.href;
    const req = new EventEmitter();
    req.destroy = () => {};

    setImmediate(() => {
      if (urlStr.includes('GetUserAuthenticatedData')) {
        const u = new URL(urlStr);
        capturedAuthPayload = JSON.parse(u.searchParams.get('data'));
        capturedAuthHash = options.headers?.hash;

        const mockAuthResponse = JSON.stringify({
          collection: {
            response: {
              responseStatus: 'SUCCESS',
              userData: {
                id: '256',
                mobile: studentNumber,
                firstName: 'ANSH',
                lastName: 'SINGH',
                classData: [
                  {
                    instId: '1',
                    instShortName: 'ABES',
                    academicYear: '2025',
                    mpId: '2',
                    classId: '4',
                    classShortName: 'FY-B.Tech CSE (14)'
                  },
                  {
                    instId: '1',
                    instShortName: 'ABES',
                    academicYear: '2025',
                    mpId: '1',
                    classId: '4',
                    classShortName: 'FY-B.Tech CSE (14)'
                  }
                ]
              }
            }
          }
        });

        const res = new EventEmitter();
        res.statusCode = 200;
        res.setEncoding = () => {};
        callback(res);
        res.emit('data', mockAuthResponse);
        res.emit('end');
      } else if (urlStr.includes('ManageExamInfo')) {
        const u = new URL(urlStr);
        capturedExamPayload = JSON.parse(u.searchParams.get('data'));
        capturedExamHash = options.headers?.hash;

        const mockExamResponse = JSON.stringify({
          collection: {
            response: {
              statusMsg: 'SUCCESS',
              examInfo: {
                publishingDetails: {
                  status: 'SUCCESS',
                  data: [
                    {
                      examClassMpCtgryTitle: 'Semester II',
                      allStudentMarksRawDataArr: [
                        {
                          fullName: 'ANSH SINGH',
                          seatNo: '2503201000228',
                          ygpa: '7.18',
                          yearlyRemark: 'PWG',
                          overAllSgpaPointsToPrint: '6.87',
                          overAllCreditEarnedPointsToPrint: 23,
                          overAllCreditPointsToPrint: 23,
                          overAllGeneralRemarks: 'PWG',
                          subjectsMarksDataArr: [
                            {
                              acadSubjectCode: '25ME201',
                              acadSubjectLngTitle: 'BASICS OF MECHANICAL AND AUTOMATION ENGINEERING',
                              subjectType: 'Theory',
                              maxPointsToPrint: 100,
                              minPointsToPrint: 40,
                              obtResolutionGracesMarksToPrint: 51,
                              gradeLetterToPrint: 'C',
                              gradePointsToPrint: '6',
                              creditPointsToPrint: 3,
                              creditEarnedToPrint: 3,
                              allExamAsmtTypeMarksDataArr: [
                                { asmtType: 'Mid Term 1', obtPoints: 7 },
                                { asmtType: 'Mid Term 2', obtPoints: 5 },
                                { asmtType: 'End Term', obtPoints: 12 },
                                { asmtType: 'CIA', obtPoints: 27 }
                              ]
                            }
                          ]
                        }
                      ]
                    },
                    {
                      examClassMpCtgryTitle: 'Semester I',
                      allStudentMarksRawDataArr: [
                        {
                          fullName: 'ANSH SINGH',
                          seatNo: '2503201000228',
                          overAllSgpaPointsToPrint: '7.48',
                          overAllCreditEarnedPointsToPrint: 23,
                          overAllCreditPointsToPrint: 23,
                          overAllGeneralRemarks: 'PASS',
                          subjectsMarksDataArr: [
                            {
                              acadSubjectCode: '25AS101',
                              acadSubjectLngTitle: 'APPLIED PHYSICS',
                              subjectType: 'Theory',
                              maxPointsToPrint: 100,
                              minPointsToPrint: 40,
                              obtResolutionGracesMarksToPrint: 65,
                              gradeLetterToPrint: 'B',
                              gradePointsToPrint: '7',
                              creditPointsToPrint: 3,
                              creditEarnedToPrint: 3,
                              allExamAsmtTypeMarksDataArr: [
                                { asmtType: 'Mid Term 1', obtPoints: 8 },
                                { asmtType: 'Mid Term 2', obtPoints: 11 },
                                { asmtType: 'End Term', obtPoints: 20 },
                                { asmtType: 'CIA', obtPoints: 26 }
                              ]
                            }
                          ]
                        }
                      ]
                    }
                  ]
                }
              }
            }
          }
        });

        const res = new EventEmitter();
        res.statusCode = 200;
        res.setEncoding = () => {};
        callback(res);
        res.emit('data', mockExamResponse);
        res.emit('end');
      } else if (urlStr.includes('ManageStudentExamAnnualwiseDashboardCardDetails')) {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.setEncoding = () => {};
        callback(res);
        res.emit('data', JSON.stringify({ collection: { response: { data: [] } } }));
        res.emit('end');
      }
    });

    return req;
  };

  try {
    await automationService.runWorkflow(session.sessionId, session.sessionToken, studentNumber);

    // 1. Verify Auth details
    assert.equal(capturedAuthHash, 'trr36pdthb9xbhcppyqkgbpkq');
    assert.equal(capturedAuthPayload.username, 'ansh14');
    assert.equal(capturedAuthPayload.password, expectedMd5);
    assert.equal(capturedAuthPayload.authMethod, 'online');

    // 2. Verify ExamInfo details
    assert.equal(capturedExamHash, 'trr36pdthb9xbhcppyqkgbpkq');
    assert.equal(capturedExamPayload.examParams.action_type, 'getAssessmentDataToShowOnMobileWithAnnual');
    assert.equal(capturedExamPayload.examParams.action_data.length, 2);
    assert.equal(capturedExamPayload.examParams.action_data[0].loggedInUsrId, '256');
    assert.equal(capturedExamPayload.examParams.action_data[0].examClassMpCtgryTitle, 'Semester II');
    assert.equal(capturedExamPayload.examParams.action_data[1].loggedInUsrId, '256');
    assert.equal(capturedExamPayload.examParams.action_data[1].examClassMpCtgryTitle, 'Semester I');

    // 3. Verify normalized session result
    const updated = sessionManager.getSession(session.sessionId, session.sessionToken);
    assert.equal(updated.status, 'ready');
    assert.ok(updated.resultData);
    assert.equal(updated.resultData.student.name, 'ANSH SINGH');
    assert.equal(updated.resultData.student.studentNumber, studentNumber);
    assert.equal(updated.resultData.overallYgpa, '7.18');
    assert.equal(updated.resultData.overallRemarks, 'PWG');
    assert.equal(updated.resultData.overallCreditsEarned, 46);

    // Verify Semesters array
    assert.equal(updated.resultData.semesters.length, 2);
    const sem1 = updated.resultData.semesters[0];
    const sem2 = updated.resultData.semesters[1];
    assert.equal(sem1.title, 'Semester I');
    assert.equal(sem1.sgpa, '7.48');
    assert.equal(sem1.creditsEarned, 23);
    assert.equal(sem1.generalRemark, 'PASS');

    assert.equal(sem2.title, 'Semester II');
    assert.equal(sem2.sgpa, '6.87');
    assert.equal(sem2.creditsEarned, 23);
    assert.equal(sem2.generalRemark, 'PWG');

    // Verify Subjects array fields
    const physics = sem1.subjects[0];
    assert.equal(physics.acadSubjectCode, '25AS101');
    assert.equal(physics.acadSubjectLngTitle, 'APPLIED PHYSICS');
    assert.equal(physics.subjectType, 'Theory');
    assert.equal(physics.maxPointsToPrint, 100);
    assert.equal(physics.minPointsToPrint, 40);
    assert.equal(physics.obtResolutionGracesMarksToPrint, 65);
    assert.equal(physics.gradeLetterToPrint, 'B');
    assert.equal(physics.gradePointsToPrint, '7');
    assert.equal(physics.creditPointsToPrint, 3);
    assert.equal(physics.creditEarnedToPrint, 3);
    assert.ok(Array.isArray(physics.allExamAsmtTypeMarksDataArr));
    assert.equal(physics.allExamAsmtTypeMarksDataArr.length, 4);

    // Verify Public State has NO PDF fields
    const pub = sessionManager.toPublicState(updated);
    assert.equal(pub.status, 'ready');
    assert.equal(pub.hasDownloadableFile, undefined);
    assert.equal(pub.downloadFileName, undefined);
    assert.equal(pub.downloadUrl, undefined);
    assert.equal(pub.pdfBase64, undefined);
    assert.equal(pub.overallYgpa, '7.18');
    assert.equal(pub.overallRemarks, 'PWG');
  } finally {
    https.get = originalHttpsGet;
  }
});
