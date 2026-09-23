// prompts.js — All LLM prompt templates

const PROMPTS = {
    summarize: `
You are a spoiler tool. You reveal what clickbait headlines hide.

STEP 1 — Question (use ONLY the headline, ignore the article text entirely):
Pretend you have NOT read the article. Look ONLY at the headline below.
What ONE piece of information does the headline make the reader curious about?
Write ONE short question in the SAME language as the headline.
The question must be something ANY reader could ask after reading ONLY the headline — no details from the article should appear in the question.

--- STOP: Do NOT let any article details leak into your question above. ---

STEP 2 — Spoiler (now read the article text):
Find the answer to your question IN THE ARTICLE TEXT. Max 15 words.
Write the answer in the SAME language as the headline.

ABSOLUTE RULES:
1. The question MUST come ONLY from the headline. A person who has not read the article must be able to understand the question.
2. The spoiler MUST be a FACT found in the article that is NOT in the headline.
3. NEVER restate, rephrase, or paraphrase the headline as the answer.
4. If the headline describes an event, the spoiler reveals the DETAILS/REASON behind it.
5. If the headline mentions someone revealed/said something, the spoiler is WHAT they said.
6. BOTH the question and the answer MUST be in the same language as the headline.
7. If the ARTICLE TEXT does NOT contain the answer, respond ONLY with:
   ❓ [question]
   💡 ❌ Could not find the answer in the article text.

CRITICAL: NEVER invent or guess the answer. You MUST quote or paraphrase a specific fact from the ARTICLE TEXT below. If you cannot point to a specific sentence in the article that contains the answer, use the ❌ response.

English examples:
- Headline: "These are the most dangerous beaches in the country"
  ❓ Which beaches are the most dangerous?
  💡 Hertzliya, Bat Yam north shore, and Ashkelon cliff beach

- Headline: "A celebrity embarrassed the host by revealing their texts"
  ❓ What did the texts say?
  💡 [actual content of the texts from the article]

- Headline: "This is how the smuggling operation worked"
  ❓ How did the smuggling operation work?
  💡 [method from article]

Hebrew examples:
- Headline: "קריסת המצוק: אלו החופים הכי מסוכנים בישראל"
  ❓ אילו חופים הכי מסוכנים?
  💡 [list of beaches from article]

- Headline: "כך פעל מערך הברחת הסחורות לרצועה"
  ❓ איך פעל מערך ההברחה?
  💡 [the method described in the article]

- Headline: "בדקנו: כמה שווה הרכב החדש של נועה קירל?"
  ❓ כמה שווה הרכב?
  💡 כ-300 אלף שקלים

Output format (nothing else):
❓ [question — derived ONLY from the headline, same language]
💡 [answer — from the article text, same language, max 15 words]

---
HEADLINE:
{{HEADLINE}}

ARTICLE TEXT:
{{TEXT}}
`,
};
