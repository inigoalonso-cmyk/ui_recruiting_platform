// Pure interview-scoring logic, kept free of DB access so it can be unit-tested
// directly (see test/scoring.test.js). The DB-backed wrapper lives in api.js.
//
// A question passes when the candidate's answer MATCHES its expected_answer —
// not simply when the answer is `true`. Some questions are phrased so the
// passing answer is `false` (e.g. "Any restriction that would stop you starting
// in 2 weeks?"). Coverage (asked/total) is independent of whether answers match.

// answers:     [{ question_id, answer: true | false | null }]  (null = not asked)
// questionMap: { [question_id]: { weight?: number, expected_answer?: 0|1|boolean } }
function scoreAnswers(answers, questionMap = {}) {
  let weightedMatch = 0;
  let weightedAsked = 0;
  let asked = 0;

  for (const a of answers) {
    // Only questions actually asked (a true/false answer) count toward scoring.
    if (a.answer === true || a.answer === false) {
      const q = questionMap[a.question_id] || {};
      const w = q.weight != null ? q.weight : 1;
      // expected_answer defaults to true when unset (legacy rows).
      const expected = q.expected_answer == null ? true : !!q.expected_answer;
      weightedAsked += w;
      if (a.answer === expected) weightedMatch += w;
      asked += 1;
    }
  }

  const score = weightedAsked > 0 ? (weightedMatch / weightedAsked) * 10 : 0;
  return { score: Math.round(score * 100) / 100, asked };
}

module.exports = { scoreAnswers };
