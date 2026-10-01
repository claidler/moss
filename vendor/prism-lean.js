/* Prism language: Lean 4 (hand-written; Prism core ships no Lean grammar). */
Prism.languages.lean = {
  'comment': [
    { pattern: /\/--[\s\S]*?--\/|\/-[\s\S]*?-\//, greedy: true },
    /--[^\r\n]*/
  ],
  'string': [
    { pattern: /"(?:\\[\s\S]|[^"\\\r\n])*"/, greedy: true },
    { pattern: /'(?:\\[\s\S]|[^'\\\r\n])'/, greedy: true }
  ],
  'attribute': { pattern: /@\[[^\]]*\]/, alias: 'metadata' },
  'command': { pattern: /#[A-Za-z_][\w.]*/, alias: 'keyword' },
  'keyword': /\b(?:theorem|example|def|lemma|abbrev|structure|class|instance|where|do|by|fun|let|have|show|suffices|calc|induction|cases|match|with|from|using|set|variable|namespace|section|end|open|import|export|mutual|partial|noncomputable|private|protected|macro|syntax|notation|macro_rules|elab|in|if|then|else|elif|for|unless|return|axiom|opaque|irreducible|reducible|semireducible|universe|run_cmd)\b/,
  'tactic': { pattern: /\b(?:intro|intros|exact|apply|refine|rw|rewrite|simp|simp_all|omega|ring|ring_nf|linarith|norm_num|decide|native_decide|tauto|constructor|left|right|exists|use|assumption|contradiction|exfalso|unfold|change|convert|conv|generalize|subst|clear|rename_i|trivial|rfl|funext|ext|congr|omega)\b/, alias: 'function' },
  'class-name': /\b[A-Z][A-Za-z0-9_']*\b/,
  'number': /\b(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?)\b/,
  'operator': /∀|∃|¬|∧|∨|↔|→|←|≤|≥|≠|:=|->|=>|::|\|>/,
  'punctuation': /[(){}\[\],;.:·!#?]/
};
Prism.languages.lean4 = Prism.languages.lean;
