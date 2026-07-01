const fetch = require('node-fetch');

const ASHBY_BASE_URL = 'https://api.ashbyhq.com';

function authHeader() {
  const key = process.env.ASHBY_API_KEY;
  if (!key) throw new Error('ASHBY_API_KEY no está configurada en las variables de entorno');
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
 * Escribe el score de pre-screening en un custom field de Ashby.
 * objectType suele ser "Application" o "Candidate" según dónde hayáis creado el campo.
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

module.exports = {
  setCustomFieldScore,
  listCustomFields,
  getCandidateInfo,
  listJobs,
};
