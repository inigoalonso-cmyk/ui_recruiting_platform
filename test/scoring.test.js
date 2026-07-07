// Run: node test/scoring.test.js
// Focused regression tests for the expected-answer scoring change (Part 1).
const assert = require('assert');
const { scoreAnswers } = require('../routes/scoring');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// The concrete regression from the spec: answer=false with expected_answer=false
// must COUNT AS A PASS (score 10/10), not a fail.
test('false answer with expected_answer=false counts as a pass', () => {
  const answers = [{ question_id: 'q1', answer: false }];
  const map = { q1: { weight: 1, expected_answer: 0 } };
  const { score, asked } = scoreAnswers(answers, map);
  assert.strictEqual(score, 10, `expected 10, got ${score}`);
  assert.strictEqual(asked, 1);
});

test('true answer with expected_answer=false counts as a fail', () => {
  const { score } = scoreAnswers([{ question_id: 'q1', answer: true }], { q1: { expected_answer: 0 } });
  assert.strictEqual(score, 0);
});

test('legacy behavior: true answer with default expected (true) still passes', () => {
  const { score } = scoreAnswers([{ question_id: 'q1', answer: true }], { q1: { weight: 1 } });
  assert.strictEqual(score, 10);
});

test('weighted mix of expected true and expected false', () => {
  // q1 expects true (w3) -> matched; q2 expects false (w1) -> matched;
  // q3 expects true (w1) -> NOT matched. weightedMatch=4, weightedAsked=5 -> 8.
  const answers = [
    { question_id: 'q1', answer: true },
    { question_id: 'q2', answer: false },
    { question_id: 'q3', answer: false },
  ];
  const map = {
    q1: { weight: 3, expected_answer: 1 },
    q2: { weight: 1, expected_answer: 0 },
    q3: { weight: 1, expected_answer: 1 },
  };
  const { score, asked } = scoreAnswers(answers, map);
  assert.strictEqual(score, 8);
  assert.strictEqual(asked, 3);
});

test('unasked questions (null) do not affect score or coverage', () => {
  const answers = [
    { question_id: 'q1', answer: true },
    { question_id: 'q2', answer: null },
  ];
  const map = { q1: { expected_answer: 1 }, q2: { expected_answer: 0 } };
  const { score, asked } = scoreAnswers(answers, map);
  assert.strictEqual(score, 10);
  assert.strictEqual(asked, 1);
});

test('no questions asked yields score 0', () => {
  const { score, asked } = scoreAnswers([{ question_id: 'q1', answer: null }], { q1: {} });
  assert.strictEqual(score, 0);
  assert.strictEqual(asked, 0);
});

console.log(`\n${passed} scoring tests passed.`);
