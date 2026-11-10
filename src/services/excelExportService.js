'use strict';

const xlsx = require('xlsx');

 
function getExportFilename(exportFilter = 'all') {
  const cleanFilter = String(exportFilter || 'all').toLowerCase().trim();
  if (cleanFilter === 'with_credentials' || cleanFilter === 'complete') {
    return 'Students_With_Credentials.xlsx';
  }
  if (cleanFilter === 'without_credentials' || cleanFilter === 'missing') {
    return 'Students_Without_Credentials.xlsx';
  }
  return 'All_Students.xlsx';
}

 
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

  
  const worksheet = xlsx.utils.aoa_to_sheet(data);

  
  for (let r = 1; r <= rows.length; r++) {
    
    const admRef = xlsx.utils.encode_cell({ r, c: 1 });
    if (worksheet[admRef]) {
      worksheet[admRef].t = 's';
      worksheet[admRef].v = String(worksheet[admRef].v || '');
      worksheet[admRef].z = '@';
    }

    
    const phoneRef = xlsx.utils.encode_cell({ r, c: 2 });
    if (worksheet[phoneRef]) {
      worksheet[phoneRef].t = 's';
      worksheet[phoneRef].v = String(worksheet[phoneRef].v || '');
      worksheet[phoneRef].z = '@';
    }

    
    const userRef = xlsx.utils.encode_cell({ r, c: 3 });
    if (worksheet[userRef]) {
      worksheet[userRef].t = 's';
      worksheet[userRef].v = String(worksheet[userRef].v || '');
    }

    
    const passRef = xlsx.utils.encode_cell({ r, c: 4 });
    if (worksheet[passRef]) {
      worksheet[passRef].t = 's';
      worksheet[passRef].v = String(worksheet[passRef].v || '');
    }
  }

  
  worksheet['!cols'] = [
    { wch: 28 }, 
    { wch: 22 }, 
    { wch: 20 }, 
    { wch: 24 }, 
    { wch: 24 }  
  ];

  
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, 'Students');

  
  return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  generateStudentsExportWorkbook,
  getExportFilename
};
