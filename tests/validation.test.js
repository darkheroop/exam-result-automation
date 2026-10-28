'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateStudentNumber, CredentialError } = require('../src/services/credentialService');

test('Input Validation - rejects non-string input', () => {
  assert.throws(() => validateStudentNumber(null), {
    name: 'CredentialError',
    statusCode: 400,
    code: 'INVALID_INPUT'
  });
  assert.throws(() => validateStudentNumber(1234567890), {
    name: 'CredentialError',
    statusCode: 400,
    code: 'INVALID_INPUT'
  });
});

test('Input Validation - rejects empty or whitespace-only input', () => {
  assert.throws(() => validateStudentNumber(''), {
    name: 'CredentialError',
    statusCode: 400,
    code: 'EMPTY_INPUT'
  });
  assert.throws(() => validateStudentNumber('    '), {
    name: 'CredentialError',
    statusCode: 400,
    code: 'EMPTY_INPUT'
  });
});

test('Input Validation - rejects identifiers that are not 10 digits', () => {
  assert.throws(() => validateStudentNumber('12345'), {
    name: 'CredentialError',
    statusCode: 400,
    code: 'INVALID_FORMAT'
  });
  assert.throws(() => validateStudentNumber('12345678901'), {
    name: 'CredentialError',
    statusCode: 400,
    code: 'INVALID_FORMAT'
  });
  assert.throws(() => validateStudentNumber('9599abc932'), {
    name: 'CredentialError',
    statusCode: 400,
    code: 'INVALID_FORMAT'
  });
});

test('Input Validation - preserves leading zeros as string', () => {
  const result = validateStudentNumber('0012345678');
  assert.equal(result, '0012345678');
  assert.equal(typeof result, 'string');
  assert.equal(result.startsWith('00'), true);
});

test('Input Validation - accepts valid 10-digit number and trims whitespace', () => {
  const result = validateStudentNumber('  9599099932  ');
  assert.equal(result, '9599099932');
});
