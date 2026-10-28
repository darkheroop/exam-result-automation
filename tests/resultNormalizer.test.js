'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { normalizeResultData } = require('../src/services/resultNormalizer');

test('ResultNormalizer - handles empty input safely', () => {
  const res = normalizeResultData({});
  assert.strictEqual(res, null);
});

test('ResultNormalizer - normalizes genuine exam data accurately', () => {
  const rawPath = path.resolve(__dirname, '../../../C:/Users/ASUS/.gemini/antigravity/brain/2470f837-f8d5-477e-a9d3-c6b6b3c12f0f/scratch/investigation_raw.json');
  if (!fs.existsSync(rawPath)) {
    // If running in environment without the scratch path, skip or mock
    return;
  }

  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  const call14 = raw.apiCalls.find(c => c.url.includes('getAssessmentDataToShowOnMobileWithAnnual'));
  const call11 = raw.apiCalls.find(c => c.url.includes('AnnualwiseDashboardCardDetails'));

  const result = normalizeResultData({
    annualwiseCardDetails: call11.fullBodyJson,
    manageExamInfoDetails: call14.fullBodyJson
  });

  assert.ok(result);
  assert.strictEqual(result.source, 'official-portal');
  assert.strictEqual(result.student.name, 'ANSH SINGH');
  assert.strictEqual(result.student.seatNo, '2503201000228');
  assert.strictEqual(result.student.className, 'FY-B.Tech CSE (14)');
  assert.strictEqual(result.student.ygpa, '7.18');
  assert.strictEqual(result.student.status, 'PWG');
  assert.strictEqual(result.student.creditsEarned, 46);
  assert.strictEqual(result.student.marks, '1811/2400');

  // Verify semesters
  assert.strictEqual(result.semesters.length, 2);
  const sem1 = result.semesters[0];
  const sem2 = result.semesters[1];

  assert.strictEqual(sem1.title, 'Semester I');
  assert.strictEqual(sem1.sgpa, '7.48');
  assert.strictEqual(sem1.earnedMarks, 899);
  assert.strictEqual(sem1.totalMarks, 1200);
  assert.strictEqual(sem1.creditsEarned, 23);
  assert.strictEqual(sem1.subjects.length, 12);

  assert.strictEqual(sem2.title, 'Semester II');
  assert.strictEqual(sem2.sgpa, '6.87');
  assert.strictEqual(sem2.earnedMarks, 912);
  assert.strictEqual(sem2.totalMarks, 1200);
  assert.strictEqual(sem2.creditsEarned, 23);
  assert.strictEqual(sem2.subjects.length, 12);

  // Check subject mapping
  const physics = sem1.subjects.find(s => s.code === '25AS101');
  assert.ok(physics);
  assert.strictEqual(physics.name, 'APPLIED PHYSICS');
  assert.strictEqual(physics.type, 'THEORY');
  assert.strictEqual(physics.midTerm1.obt, 8);
  assert.strictEqual(physics.midTerm2.obt, 11);
  assert.strictEqual(physics.endTerm.obt, 20);
  assert.strictEqual(physics.external.obt, 39);
  assert.strictEqual(physics.internal.obt, 26);
  assert.strictEqual(physics.total.obt, 65);
  assert.strictEqual(physics.grade, 'B');
  assert.strictEqual(physics.gradePoints, 7);
  assert.strictEqual(physics.creditGrade, 21);
  assert.strictEqual(physics.result, 'PASS');

  // Check lab subject mapping
  const physicsLab = sem1.subjects.find(s => s.code === '25AS151');
  assert.ok(physicsLab);
  assert.strictEqual(physicsLab.name, 'PHYSICS LAB');
  assert.strictEqual(physicsLab.type, 'LAB');
  assert.strictEqual(physicsLab.midTerm1, null);
  assert.strictEqual(physicsLab.midTerm2, null);
  assert.strictEqual(physicsLab.endTerm, null);
  assert.strictEqual(physicsLab.external.obt, 44);
  assert.strictEqual(physicsLab.internal.obt, 45);
  assert.strictEqual(physicsLab.total.obt, 89);
  assert.strictEqual(physicsLab.grade, 'A');
  assert.strictEqual(physicsLab.gradePoints, 9);
  assert.strictEqual(physicsLab.creditGrade, 9);
  assert.strictEqual(physicsLab.result, 'PASS');
});
