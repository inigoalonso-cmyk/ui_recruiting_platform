const fetch = require('node-fetch');

const ASHBY_BASE_URL = 'https://api.ashbyhq.com';

function authHeader() {
  const key = process.env.ASHBY_API_KEY;
  if (!key) throw new Error('ASHBY_API_KEY is not set in the environment variables');
  const token = Buffer.from(`${key}:`).toString('base64');
  return `Basic ${token}`;
}

async function ashbyRequest(method, body = {}) {
  const res = await fetch(`${ASHBY_BASE_URL}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader(),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.success === false) {
    const msg = (data.errors && data.errors.join(', ')) || res.statusText;
    throw new Error(`Ashby API error (${method}): ${msg}`);
  }
  return data;
}

/**
 * Writes the pre-screening score to a custom field in Ashby.
 * objectType is usually "Application" or "Candidate" depending on where the field was created.
 */
async function setCustomFieldScore({ objectId, objectType, fieldId, value }) {
  return ashbyRequest('customField.setValue', {
    objectId,
    objectType,
    fieldId,
    fieldValue: value,
  });
}

async function listCustomFields() {
  return ashbyRequest('customField.list', {});
}

async function getCandidateInfo(candidateId) {
  return ashbyRequest('candidate.info', { id: candidateId });
}

async function listJobs() {
  return ashbyRequest('job.list', {});
}

/**
 * Fetch a single application (used to resolve which job an application belongs
 * to, and its current interview stage).
 */
async function getApplicationInfo(applicationId) {
  return ashbyRequest('application.info', { applicationId });
}

/**
 * Best-effort live lookup of a candidate by phone number.
 *
 * NOTE: Ashby's documented `candidate.search` supports `email` and `name`.
 * Phone search is NOT confirmed in the docs, so we send the phone under a few
 * plausible keys and let Ashby ignore the ones it doesn't understand. Callers
 * MUST still verify each returned candidate's phone numbers themselves (see
 * routes/api.js), and treat an empty/errored result as "no match". Verify the
 * real request shape against the Ashby API reference before relying on this.
 */
async function searchCandidatesByPhone(phone) {
  const data = await ashbyRequest('candidate.search', { phoneNumber: phone, phone });
  return (data && data.results) || [];
}

module.exports = {
  setCustomFieldScore,
  listCustomFields,
  getCandidateInfo,
  getApplicationInfo,
  searchCandidatesByPhone,
  listJobs,
};
