'use strict';

/**
 * Normalizes genuine portal API responses into a clean, consistent data structure for the frontend marksheet.
 * Thoroughly extracts Semester I and Semester II data from ManageExamInfo publishingDetails:
 * - Semesters array with semester name/title, SGPA, credits earned, total credits, general remarks.
 * - Overall YGPA, overall credits earned, overall total credits, overall remarks.
 * - Subjects array for each semester with acadSubjectCode, acadSubjectLngTitle, subjectType,
 *   maxPointsToPrint, minPointsToPrint, obtResolutionGracesMarksToPrint, gradeLetterToPrint,
 *   gradePointsToPrint, creditPointsToPrint, creditEarnedToPrint, and allExamAsmtTypeMarksDataArr.
 */
function normalizeResultData({
  annualwiseCardDetails,
  manageExamInfoDetails,
  semesterwiseCardDetails,
  expectedStudentNumber = null,
  authenticatedUserData = null
}) {
  if (!annualwiseCardDetails && !manageExamInfoDetails) {
    return null;
  }

  // Identity Verification: If authenticated user data is available, verify it belongs to expected student
  if (expectedStudentNumber && authenticatedUserData && authenticatedUserData.mobile) {
    const authMobile = String(authenticatedUserData.mobile).trim();
    const expected = String(expectedStudentNumber).trim();
    if (authMobile !== expected) {
      const err = new Error(`Student identity mismatch: authenticated account (${authMobile}) does not match requested student (${expected}).`);
      err.code = 'STUDENT_IDENTITY_MISMATCH';
      throw err;
    }
  }

  // Extract annual cards if provided
  const annualCards = annualwiseCardDetails?.collection?.response?.data || 
                      annualwiseCardDetails?.data || 
                      (Array.isArray(annualwiseCardDetails) ? annualwiseCardDetails : []);

  // Find published annual card (one that has ygpa and yearlyRemark), or fallback to first card
  const publishedCard = annualCards.find(c => c.ygpa && c.yearlyRemark) || annualCards[0] || {};

  // Extract exam info publishing details
  const pubDetails = manageExamInfoDetails?.collection?.response?.examInfo?.publishingDetails || 
                     manageExamInfoDetails?.examInfo?.publishingDetails || 
                     manageExamInfoDetails?.publishingDetails;
  const semDataArr = pubDetails?.data || [];

  // Find student metadata across semester records
  const firstSem = semDataArr[0] || {};
  const rawStudent = firstSem?.allStudentMarksRawDataArr?.[0] || {};

  // Find a student record that has YGPA or yearlyRemark populated (e.g. from Sem II)
  let rawStudentWithYgpa = null;
  for (const sem of semDataArr) {
    const s = sem.allStudentMarksRawDataArr?.[0];
    if (s && (s.ygpa || s.yearlyRemark)) {
      rawStudentWithYgpa = s;
      break;
    }
  }
  if (!rawStudentWithYgpa) rawStudentWithYgpa = rawStudent;

  const sYear = publishedCard.acadSyear || firstSem?.examClassMpCtgryAcademicYears || '2025';
  const nextYear = parseInt(sYear, 10) + 1;

  // Extract result publish date
  let publishedOn = '2026-07-22';
  if (rawStudent.resultPublishDate) {
    publishedOn = rawStudent.resultPublishDate;
  } else if (rawStudent.resultPublishDetails?.[0]?.resultPublishDate) {
    publishedOn = rawStudent.resultPublishDetails[0].resultPublishDate;
  } else if (publishedCard.semesters?.[0]?.resultPublishDate) {
    publishedOn = publishedCard.semesters[0].resultPublishDate;
  }

  // Sort semesters so Semester I is first (index 0), Semester II is second (index 1)
  const sortedSems = [...semDataArr].sort((a, b) => {
    const titleA = (a.examClassMpCtgryTitle || '').toUpperCase();
    const titleB = (b.examClassMpCtgryTitle || '').toUpperCase();
    const isSem1A = titleA.includes('SEMESTER I') && !titleA.includes('SEMESTER II') && !titleA.includes('SEMESTER III');
    const isSem1B = titleB.includes('SEMESTER I') && !titleB.includes('SEMESTER II') && !titleB.includes('SEMESTER III');
    if (isSem1A) return -1;
    if (isSem1B) return 1;
    return 0;
  });

  const semesters = sortedSems.map((sem, sIdx) => {
    const semTitle = sem.examClassMpCtgryTitle || (sIdx === 0 ? 'Semester I' : 'Semester II');
    const semNumber = semTitle.includes('II') ? 2 : (semTitle.includes('I') ? 1 : sIdx + 1);

    // Match semester metadata from publishedCard using strict matching if card is available
    const cardSem = (publishedCard.semesters || []).find(s => {
      const cardTitle = (s.semesterTitle || '').trim().toUpperCase();
      if (semNumber === 1) {
        return cardTitle === 'SEMESTER I' || cardTitle === 'SEM I' || cardTitle === 'SEM-1' || (cardTitle.includes('I') && !cardTitle.includes('II') && !cardTitle.includes('III'));
      }
      if (semNumber === 2) {
        return cardTitle === 'SEMESTER II' || cardTitle === 'SEM II' || cardTitle === 'SEM-2' || (cardTitle.includes('II') && !cardTitle.includes('III'));
      }
      return cardTitle === semTitle.trim().toUpperCase();
    }) || {};

    const studMarks = sem.allStudentMarksRawDataArr?.[0] || {};
    const rawSubjects = studMarks.subjectsMarksDataArr || [];

    const subjects = rawSubjects.map(sub => {
      const isTheory = (sub.subjectType || '').toLowerCase() === 'theory';
      const asmtArr = sub.allExamAsmtTypeMarksDataArr || [];

      const findAsmt = (type) => asmtArr.find(a => (a.asmtType || '').toLowerCase() === type.toLowerCase());

      const mt1 = findAsmt('Mid Term 1');
      const mt2 = findAsmt('Mid Term 2');
      const endTerm = findAsmt('End Term');
      const cia = findAsmt('CIA');
      const ext = findAsmt('External');
      const intAsmt = findAsmt('Internal');

      let externalObj = null;
      let internalObj = null;

      if (isTheory) {
        const extObt = (mt1 ? Number(mt1.obtPoints || 0) : 0) + 
                       (mt2 ? Number(mt2.obtPoints || 0) : 0) + 
                       (endTerm ? Number(endTerm.obtPoints || 0) : 0);
        externalObj = {
          obt: extObt,
          min: 21,
          max: 70
        };
        internalObj = {
          obt: cia ? Number(cia.obtPoints || 0) : 0,
          min: 0,
          max: 30
        };
      } else {
        externalObj = ext ? {
          obt: Number(ext.obtPoints || 0),
          min: Number(ext.minPoints || 0),
          max: Number(ext.maxPoints || 0)
        } : null;
        internalObj = intAsmt ? {
          obt: Number(intAsmt.obtPoints || 0),
          min: Number(intAsmt.minPoints || 0),
          max: Number(intAsmt.maxPoints || 0)
        } : null;
      }

      const totalObt = sub.obtResolutionGracesPoints !== undefined
        ? Number(sub.obtResolutionGracesPoints)
        : (sub.obtPoints !== undefined ? Number(sub.obtPoints) : 0);

      const creditPoints = Number(sub.creditPoints !== undefined ? sub.creditPoints : (sub.creditPointsToPrint || 0));
      const gradePoints = Number(sub.gradePoints !== undefined ? sub.gradePoints : (sub.gradePointsToPrint || 0));
      const creditEarned = sub.creditEarned !== undefined
        ? Number(sub.creditEarned)
        : (sub.creditEarnedToPrint !== undefined ? Number(sub.creditEarnedToPrint) : creditPoints);
      const cgPoints = sub.cgPoints !== undefined ? Number(sub.cgPoints) : (creditPoints * gradePoints);

      const grade = sub.gradeLetter || sub.gradeLetterToPrint || '';
      let result = 'PASS';
      if (grade === 'F') {
        result = 'FAIL';
      } else if (grade === 'E#') {
        result = 'PWG';
      } else if (gradePoints === 0 && creditPoints > 0) {
        result = 'FAIL';
      }

      return {
        // Explicit required subject fields
        acadSubjectCode: sub.acadSubjectCode || '',
        acadSubjectLngTitle: sub.acadSubjectLngTitle || '',
        subjectType: sub.subjectType || (isTheory ? 'Theory' : 'Practical'),
        maxPointsToPrint: sub.maxPointsToPrint !== undefined ? sub.maxPointsToPrint : (sub.maxPoints !== undefined ? Number(sub.maxPoints) : 100),
        minPointsToPrint: sub.minPointsToPrint !== undefined ? sub.minPointsToPrint : (sub.minPoints !== undefined ? Number(sub.minPoints) : 40),
        obtResolutionGracesMarksToPrint: sub.obtResolutionGracesMarksToPrint !== undefined
          ? sub.obtResolutionGracesMarksToPrint
          : (sub.obtResolutionGracesPoints !== undefined ? sub.obtResolutionGracesPoints : totalObt),
        gradeLetterToPrint: sub.gradeLetterToPrint || sub.gradeLetter || '',
        gradePointsToPrint: sub.gradePointsToPrint !== undefined ? sub.gradePointsToPrint : (sub.gradePoints !== undefined ? String(sub.gradePoints) : ''),
        creditPointsToPrint: sub.creditPointsToPrint !== undefined ? sub.creditPointsToPrint : creditPoints,
        creditEarnedToPrint: sub.creditEarnedToPrint !== undefined ? sub.creditEarnedToPrint : creditEarned,
        allExamAsmtTypeMarksDataArr: sub.allExamAsmtTypeMarksDataArr || [],

        // Preserved backward-compatible fields
        code: sub.acadSubjectCode || '',
        name: sub.acadSubjectLngTitle || '',
        title: sub.acadSubjectLngTitle || '',
        type: isTheory ? 'THEORY' : 'LAB',
        midTerm1: mt1 ? {
          obt: Number(mt1.obtPoints || 0),
          min: Number(mt1.minPoints || 0),
          max: Number(mt1.maxPoints || 0)
        } : null,
        midTerm2: mt2 ? {
          obt: Number(mt2.obtPoints || 0),
          min: Number(mt2.minPoints || 0),
          max: Number(mt2.maxPoints || 0)
        } : null,
        endTerm: endTerm ? {
          obt: Number(endTerm.obtPoints || 0),
          min: Number(endTerm.minPoints || 0),
          max: Number(endTerm.maxPoints || 0)
        } : null,
        external: externalObj,
        internal: internalObj,
        total: {
          obt: totalObt,
          min: Number(sub.minPoints || 40),
          max: Number(sub.maxPoints || 100)
        },
        credits: creditPoints,
        creditsEarned: creditEarned,
        grade: grade,
        gradePoints: gradePoints,
        creditGrade: cgPoints,
        result: result
      };
    });

    const semEarnedMarks = cardSem.earnedMarks !== undefined && cardSem.earnedMarks !== ''
      ? Number(cardSem.earnedMarks)
      : (studMarks.overAllObtResolutionGracesPoints !== undefined && studMarks.overAllObtResolutionGracesPoints !== ''
         ? Number(studMarks.overAllObtResolutionGracesPoints)
         : (studMarks.overAllObtResolutionGracesPointsToPrint !== undefined && studMarks.overAllObtResolutionGracesPointsToPrint !== ''
            ? Number(studMarks.overAllObtResolutionGracesPointsToPrint)
            : subjects.reduce((sum, s) => sum + s.total.obt, 0)));

    const semTotalMarks = cardSem.totalMarks !== undefined && cardSem.totalMarks !== ''
      ? Number(cardSem.totalMarks)
      : (studMarks.overAllMaxPoints !== undefined && studMarks.overAllMaxPoints !== ''
         ? Number(studMarks.overAllMaxPoints)
         : (studMarks.overAllMaxPointsToPrint !== undefined && studMarks.overAllMaxPointsToPrint !== ''
            ? Number(studMarks.overAllMaxPointsToPrint)
            : subjects.reduce((sum, s) => sum + s.total.max, 0)));

    const semCredits = cardSem.credits !== undefined && cardSem.credits !== ''
      ? Number(cardSem.credits)
      : (studMarks.overAllCreditPoints !== undefined && studMarks.overAllCreditPoints !== ''
         ? Number(studMarks.overAllCreditPoints)
         : (studMarks.overAllCreditPointsToPrint !== undefined && studMarks.overAllCreditPointsToPrint !== ''
            ? Number(studMarks.overAllCreditPointsToPrint)
            : subjects.reduce((sum, s) => sum + s.credits, 0)));

    const semEarnedCredits = cardSem.earnedCredits !== undefined && cardSem.earnedCredits !== ''
      ? Number(cardSem.earnedCredits)
      : (studMarks.overAllCreditEarnedPoints !== undefined && studMarks.overAllCreditEarnedPoints !== ''
         ? Number(studMarks.overAllCreditEarnedPoints)
         : (studMarks.overAllCreditEarnedPointsToPrint !== undefined && studMarks.overAllCreditEarnedPointsToPrint !== ''
            ? Number(studMarks.overAllCreditEarnedPointsToPrint)
            : subjects.reduce((sum, s) => sum + s.creditsEarned, 0)));

    const semSgpa = cardSem.sgpa !== undefined && cardSem.sgpa !== ''
      ? String(cardSem.sgpa)
      : (studMarks.overAllSgpaPointsToPrint !== undefined && studMarks.overAllSgpaPointsToPrint !== ''
         ? String(studMarks.overAllSgpaPointsToPrint)
         : (studMarks.overAllSgpaPoints !== undefined && studMarks.overAllSgpaPoints !== '' ? String(studMarks.overAllSgpaPoints) : ''));

    const semRemark = cardSem.generalRemark ||
                      studMarks.overAllGeneralRemarks ||
                      studMarks.overAllRemarks ||
                      (semNumber === 2 && (publishedCard.yearlyRemark === 'PWG' || rawStudentWithYgpa.yearlyRemark === 'PWG') ? 'PWG' : 'PASS');

    return {
      semesterNumber: semNumber,
      title: semTitle,
      name: semTitle,
      semesterTitle: semTitle,
      sgpa: semSgpa,
      totalMarks: semTotalMarks,
      earnedMarks: semEarnedMarks,
      obtainedMarks: semEarnedMarks,
      marks: `${semEarnedMarks}/${semTotalMarks}`,
      credits: semCredits,
      totalCredits: semCredits,
      earnedCredits: semEarnedCredits,
      creditsEarned: semEarnedCredits,
      status: semRemark,
      generalRemark: semRemark,
      generalRemarks: semRemark,
      subjects
    };
  });

  // Calculate overall YGPA, overall credits earned, overall total credits, overall remarks
  const overallYgpa = publishedCard.ygpa !== undefined && publishedCard.ygpa !== ''
    ? String(publishedCard.ygpa)
    : (rawStudentWithYgpa.ygpa !== undefined && rawStudentWithYgpa.ygpa !== '' ? String(rawStudentWithYgpa.ygpa) : '');

  const overallRemarks = publishedCard.yearlyRemark ||
                         rawStudentWithYgpa.yearlyRemark ||
                         rawStudentWithYgpa.overAllGeneralRemarks ||
                         rawStudentWithYgpa.overAllRemarks ||
                         'PASS';

  const overallCreditsEarned = publishedCard.totalEarnedCredits !== undefined && publishedCard.totalEarnedCredits !== ''
    ? Number(publishedCard.totalEarnedCredits)
    : (publishedCard.totalCredits !== undefined && publishedCard.totalCredits !== ''
       ? Number(publishedCard.totalCredits)
       : semesters.reduce((sum, sem) => sum + sem.creditsEarned, 0));

  const overallTotalCredits = publishedCard.totalCredits !== undefined && publishedCard.totalCredits !== ''
    ? Number(publishedCard.totalCredits)
    : semesters.reduce((sum, sem) => sum + sem.totalCredits, 0);

  const overallEarnedMarks = publishedCard.earnedMarks !== undefined && publishedCard.earnedMarks !== ''
    ? Number(publishedCard.earnedMarks)
    : semesters.reduce((sum, sem) => sum + sem.earnedMarks, 0);

  const overallTotalMarks = publishedCard.totalMarks !== undefined && publishedCard.totalMarks !== ''
    ? Number(publishedCard.totalMarks)
    : semesters.reduce((sum, sem) => sum + sem.totalMarks, 0);

  const student = {
    name: rawStudent.fullName || 'STUDENT',
    fullName: rawStudent.fullName || 'STUDENT',
    studentNumber: expectedStudentNumber || (authenticatedUserData ? authenticatedUserData.mobile : '') || '',
    regnNo: rawStudent.seatNo || rawStudent.rollNo || publishedCard.seatNo || '',
    seatNo: rawStudent.seatNo || publishedCard.seatNo || '',
    rollNo: rawStudent.rollNo || '',
    pnrNo: rawStudent.pnrNo || '',
    className: publishedCard.acadClassTitle || rawStudent.classAffPrgLngName || rawStudent.classNameLedger || 'FY-B.Tech CSE',
    course: rawStudent.classAffPrgLngName || 'Bachelor of Technology in Computer Science & Engineering',
    motherName: rawStudent.motherName || '',
    fatherName: rawStudent.fatherName || '',
    academicYear: sYear,
    publishedOn: publishedOn,
    session: `${sYear}-${String(nextYear).slice(-2)} (REGULAR)`,
    abcId: rawStudent.abcId || '#N/A',
    semesters: '1, 2',
    status: overallRemarks,
    ygpa: overallYgpa,
    creditsEarned: overallCreditsEarned,
    totalCredits: overallTotalCredits,
    obtainedMarks: overallEarnedMarks,
    totalMarks: overallTotalMarks,
    marks: `${overallEarnedMarks}/${overallTotalMarks}`,
    cop: publishedCard.failedSubjectCodes ? publishedCard.failedSubjectCodes : '—',
    overallYgpa,
    overallCreditsEarned,
    overallRemarks
  };

  const institution = {
    name: 'ABES Engineering College',
    subTitle: '(Autonomous College)',
    accreditation: 'NAAC Accredited, NBA Accredited B.Tech. Branches (CSE, ECE, ME)',
    affiliation: 'Approved by AICTE, New Delhi & Affiliated to Dr. APJ Abdul Kalam Technical University, Lucknow, UP',
    address: '19th Km Stone, NH-09, Ghaziabad, UP, (INDIA)',
    headerTitle: 'ABES Engineering College : Annual Result'
  };

  const annualSummary = {
    status: student.status,
    ygpa: student.ygpa,
    overallYgpa,
    creditsEarned: student.creditsEarned,
    overallCreditsEarned,
    totalCredits: student.totalCredits,
    overallTotalCredits,
    overallRemarks,
    obtainedMarks: student.obtainedMarks,
    totalMarks: student.totalMarks,
    marksRatio: student.marks,
    cop: student.cop
  };

  return {
    student,
    institution,
    annualSummary,
    semesters,
    overallYgpa,
    overallCreditsEarned,
    overallTotalCredits,
    overallRemarks,
    source: 'official-portal'
  };
}

module.exports = {
  normalizeResultData
};
