'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AdminDbService } = require('../src/services/adminDbService');

test('AdminDb - upsertStudent with duplicate detection and credential preservation', async () => {
  const db = new AdminDbService();

  // 1. Initial Insert
  const { student: s1, isUpdate: isUp1 } = await db.upsertStudent({
    name: 'Rohit Sharma',
    admission_number: '2023CS001',
    phone_number: '9876543210',
    username: 'rohit45',
    password: 'secure_password_45',
    section: 'CSE-A'
  });

  assert.equal(isUp1, false);
  assert.equal(s1.name, 'Rohit Sharma');
  assert.equal(s1.admission_number, '2023CS001');
  assert.equal(s1.username, 'rohit45');
  assert.equal(s1.password, 'secure_password_45');
  assert.equal(s1.section, 'CSE-A');

  // 2. Re-import / re-upsert from Excel with empty username and password
  const { student: s2, isUpdate: isUp2 } = await db.upsertStudent({
    name: 'Rohit Sharma Updated',
    admission_number: '2023CS001',
    phone_number: '9876500000',
    username: '',
    password: '',
    section: 'CSE-B'
  });

  assert.equal(isUp2, true);
  assert.equal(s2.id, s1.id);
  assert.equal(s2.name, 'Rohit Sharma Updated');
  assert.equal(s2.phone_number, '9876500000');
  assert.equal(s2.section, 'CSE-B');
  // CRITICAL REQUIREMENT: existing username & password MUST NOT be overwritten!
  assert.equal(s2.username, 'rohit45');
  assert.equal(s2.password, 'secure_password_45');

  // 3. Upsert with explicit new credentials should update them
  const { student: s3, isUpdate: isUp3 } = await db.upsertStudent({
    name: 'Rohit Sharma Updated',
    admission_number: '2023CS001',
    phone_number: '9876500000',
    username: 'rohit_new',
    password: 'new_password',
    section: 'CSE-B'
  });
  assert.equal(isUp3, true);
  assert.equal(s3.username, 'rohit_new');
  assert.equal(s3.password, 'new_password');
});

test('AdminDb - listStudents with search, section filter, sorting, and pagination', async () => {
  const db = new AdminDbService();

  await db.upsertStudent({ name: 'Alpha Student', admission_number: 'ADM101', phone_number: '9111111111', section: 'Sec-A' });
  await db.upsertStudent({ name: 'Beta Student', admission_number: 'ADM102', phone_number: '9222222222', section: 'Sec-A' });
  await db.upsertStudent({ name: 'Gamma Student', admission_number: 'ADM103', phone_number: '9333333333', section: 'Sec-B' });
  await db.upsertStudent({ name: 'Delta Student', admission_number: 'ADM104', phone_number: '9444444444', section: 'Sec-B' });
  await db.upsertStudent({ name: 'Epsilon Student', admission_number: 'ADM105', phone_number: '9555555555', section: 'Sec-C' });

  // 1. Pagination
  const page1 = await db.listStudents({ page: 1, limit: 2 });
  assert.equal(page1.students.length, 2);
  assert.equal(page1.total, 5);
  assert.equal(page1.totalPages, 3);
  assert.equal(page1.page, 1);

  // 2. Section filter
  const secB = await db.listStudents({ section: 'Sec-B' });
  assert.equal(secB.students.length, 2);
  assert.equal(secB.total, 2);
  assert.ok(secB.students.every(s => s.section === 'Sec-B'));

  // 3. Universal search by name
  const searchName = await db.listStudents({ search: 'gamma' });
  assert.equal(searchName.total, 1);
  assert.equal(searchName.students[0].name, 'Gamma Student');

  // 4. Universal search by admission number
  const searchAdm = await db.listStudents({ search: 'ADM105' });
  assert.equal(searchAdm.total, 1);
  assert.equal(searchAdm.students[0].name, 'Epsilon Student');

  // 5. Universal search by phone
  const searchPhone = await db.listStudents({ search: '922222' });
  assert.equal(searchPhone.total, 1);
  assert.equal(searchPhone.students[0].name, 'Beta Student');

  // 6. Sorting DESC by name
  const sorted = await db.listStudents({ sortBy: 'name', sortOrder: 'DESC' });
  assert.equal(sorted.students[0].name, 'Gamma Student');

  // 7. Credential filtering
  await db.upsertStudent({ name: 'User With Credentials', admission_number: 'ADM991', phone_number: '9999999991', section: 'Sec-A', username: 'hasuser', password: 'haspassword' });
  await db.upsertStudent({ name: 'User Missing Password', admission_number: 'ADM992', phone_number: '9999999992', section: 'Sec-A', username: 'useronly', password: '' });
  await db.upsertStudent({ name: 'User Missing Username', admission_number: 'ADM993', phone_number: '9999999993', section: 'Sec-A', username: '', password: 'pwdonly' });

  const completeCreds = await db.listStudents({ credential: 'complete' });
  assert.ok(completeCreds.students.some(s => s.admission_number === 'ADM991'));
  assert.ok(completeCreds.students.every(s => s.username && s.password));

  const missingUser = await db.listStudents({ credential: 'missing_username' });
  assert.ok(missingUser.students.some(s => s.admission_number === 'ADM993'));
  assert.ok(missingUser.students.every(s => !s.username));

  const missingPass = await db.listStudents({ credential: 'missing_password' });
  assert.ok(missingPass.students.some(s => s.admission_number === 'ADM992'));
  assert.ok(missingPass.students.every(s => !s.password));
});

test('AdminDb - updateStudent and deleteStudent', async () => {
  const db = new AdminDbService();

  const { student } = await db.upsertStudent({
    name: 'Original Name',
    admission_number: 'ADM555',
    phone_number: '9000000000',
    username: 'user555',
    password: 'pwd555',
    section: 'ME-A'
  });

  // Update without modifying password
  const updated = await db.updateStudent(student.id, {
    name: 'Modified Name',
    section: 'ME-B'
  });
  assert.equal(updated.name, 'Modified Name');
  assert.equal(updated.section, 'ME-B');
  assert.equal(updated.username, 'user555');
  assert.equal(updated.password, 'pwd555');

  // Delete
  const deleted = await db.deleteStudent(student.id);
  assert.equal(deleted, true);

  const lookup = await db.getStudentById(student.id);
  assert.equal(lookup, null);
});

test('AdminDb - batchUpsertStudents and getDashboardStats', async () => {
  const db = new AdminDbService();

  const batch = [
    { name: 'Student 1', admission_number: 'B01', phone_number: '111', section: 'A', username: 'u1', password: 'p1' },
    { name: 'Student 2', admission_number: 'B02', phone_number: '222', section: 'A', username: '', password: '' },
    { name: 'Student 3', admission_number: 'B03', phone_number: '333', section: 'B', username: 'u3', password: '' },
    { name: 'Student 1 Updated', admission_number: 'B01', phone_number: '111-updated', section: 'A' }, // Duplicate in batch
    { name: 'Invalid Missing Adm', admission_number: '', phone_number: '999' } // Skipped
  ];

  const summary = await db.batchUpsertStudents(batch);
  assert.equal(summary.added, 3);
  assert.equal(summary.updated, 1);
  assert.equal(summary.duplicates, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.total, 5);

  const stats = await db.getDashboardStats();
  assert.equal(stats.totalStudents, 3);
  assert.equal(stats.totalSections, 2);
  assert.equal(stats.studentsWithUsername, 2); // u1, u3
  assert.equal(stats.studentsWithoutUsername, 1); // B02
  assert.equal(stats.studentsWithPassword, 1); // p1
  assert.equal(stats.studentsWithoutPassword, 2); // B02, B03
  assert.equal(stats.sectionBreakdown.length, 2);
});
