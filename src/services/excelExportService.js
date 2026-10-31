'use strict';

const xlsx = require('xlsx');

/**
 * Returns a standardized filename for the student export using the current or given date:
 * e.g. Student_Records_2026-10-31.xlsx
 */
function getExportFilename(date = new Date()) {
  const d = date instanceof Date && !isNaN(date) ? date : new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `Student_Records_${yyyy}-${mm}-${dd}.xlsx`;
}

/**
 * Generates an Excel (.xlsx) workbook buffer containing the specified student records.
 * 
 * Exactly five student fields are exported:
 * 1. Student Name
 * 2. Admission Number
 * 3. Phone Number
 * 4. Username
 * 5. Password
 * 
 * Excludes internal IDs, timestamps, search logs, exceptions, and admin data.
 * Guarantees leading zeros in admission and phone numbers are preserved as text.
 * 
 * @param {Array<Object>} students List of student records from database
 * @returns {Buffer} Binary buffer of the .xlsx workbook
 */
function generateStudentsExportWorkbook(students = []) {
  const safeStudents = Array.isArray(students) ? students : [];

  const headers = [
    'Student Name',
    'Admission Number',
    'Phone Number',
    'Username',
    'Password'
  ];

  const rows = safeStudents.map(s => {
    const studentName = String(s.student_name || s.name || '').trim();
    const admissionNumber = String(s.admission_number || s.admissionNumber || '').trim();
    const phoneNumber = String(s.phone_number || s.phone || '').trim();
    const username = String(s.portal_username || s.username || '').trim();
    const password = String(s.portal_password || s.password || '').trim();

    return [
      studentName,
      admissionNumber,
      phoneNumber,
      username,
      password
    ];
  });

  const data = [headers, ...rows];

  // Create worksheet from Array-of-Arrays
  const worksheet = xlsx.utils.aoa_to_sheet(data);

  // Explicitly ensure text format ('s') for phone and admission number to preserve leading zeros
  for (let r = 1; r <= rows.length; r++) {
    // Admission Number (Col 1 = B)
    const admRef = xlsx.utils.encode_cell({ r, c: 1 });
    if (worksheet[admRef]) {
      worksheet[admRef].t = 's';
      worksheet[admRef].v = String(worksheet[admRef].v || '');
      worksheet[admRef].z = '@';
    }

    // Phone Number (Col 2 = C)
    const phoneRef = xlsx.utils.encode_cell({ r, c: 2 });
    if (worksheet[phoneRef]) {
      worksheet[phoneRef].t = 's';
      worksheet[phoneRef].v = String(worksheet[phoneRef].v || '');
      worksheet[phoneRef].z = '@';
    }

    // Username (Col 3 = D)
    const userRef = xlsx.utils.encode_cell({ r, c: 3 });
    if (worksheet[userRef]) {
      worksheet[userRef].t = 's';
      worksheet[userRef].v = String(worksheet[userRef].v || '');
    }

    // Password (Col 4 = E)
    const passRef = xlsx.utils.encode_cell({ r, c: 4 });
    if (worksheet[passRef]) {
      worksheet[passRef].t = 's';
      worksheet[passRef].v = String(worksheet[passRef].v || '');
    }
  }

  // Readable column widths
  worksheet['!cols'] = [
    { wch: 28 }, // Student Name
    { wch: 22 }, // Admission Number
    { wch: 20 }, // Phone Number
    { wch: 24 }, // Username
    { wch: 24 }  // Password
  ];

  // Create workbook and append sheet
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, 'Students');

  // Generate buffer
  return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  generateStudentsExportWorkbook,
  getExportFilename
};
