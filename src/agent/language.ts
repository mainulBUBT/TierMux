

// Lightweight, deterministic language detection for the user's latest message.
// Used by promptBuilder to add a "reply in the user's language" tail so a free/weak model
// that defaults to English stops translating Romanized Bengali (or any other non-English
// input) into an unrelated English guess. Cheaper and more reliable than an LLM call.
//
// Returns null when the message is plain English (or has no detectable language signal) —
// the absence of a tail leaves the model's default English behavior unchanged for users
// who actually wrote in English.

export type DetectedLanguage = 'bn' | 'hi' | 'ur' | 'ar' | 'fa' | 'zh' | 'ja' | 'ko' | 'th' | 'ta' | 'ru' | 'en-banglish' | 'en-hinglish';

const NON_LATIN_SCRIPTS: Array<[DetectedLanguage, RegExp]> = [
  ['bn', /[\u0980-\u09FF]/],  // Bengali
  ['hi', /[\u0900-\u097F]/],  // Devanagari (Hindi, Marathi, Sanskrit, Nepali)
  ['ur', /[\u0600-\u06FF]/],  // Arabic-script (Urdu, Persian — disambiguated below)
  ['ar', /[\u0600-\u06FF]/],
  ['fa', /[\u0698\u067E\u0686\u06AF\u06CC]/], // Persian-only letters
  ['zh', /[\u4E00-\u9FFF]/],  // CJK
  ['ja', /[\u3040-\u30FF]/],  // Hiragana + Katakana
  ['ko', /[\uAC00-\uD7AF]/],  // Hangul
  ['th', /[\u0E00-\u0E7F]/],  // Thai
  ['ta', /[\u0B80-\u0BFF]/],  // Tamil
  ['ru', /[\u0400-\u04FF]/],  // Cyrillic (Russian, Ukrainian, etc.)
];

/** Romanized Bengali (Banglish) signal tokens — union of the verb/explain/debug sets already
 *  proven on this user in src/agent/routing.ts. Kept in sync; routing uses these for task
 *  classification (read-only Q&A vs edit-capable agent), we use them here for the response-
 *  side mirror so the model actually answers in Banglish instead of mistranslating. */
const BN_BANGLISH = /\b(kor(?:o|un|be|chi|te|ben|te ?hobe)?|kore ?(?:dao|den|dio)|banao|banan|banate|likh(?:o|un|te)?|lekho|thik ?kor\w*|muche ?(?:dao|felo)|poriborton|bodla(?:o|te)|joga(?:o|te)|add ?kor\w*|fix ?kor\w*|update ?kor\w*|delete ?kor\w*|ki+\b|kiser|kivabe|ki ?vabe|kemne|kemon|keno|kothay|kon\b|kobe|kar\b|kaj ?ki|kaj ?kore|bujhi?ye|bujhte|bujhao|bojhao|bujhai|mane ?ki|bujhena|bujhlam|hocche|hoy|hoche|ase|ashe|chole|thake|hocchilo|hoyeche|ache|chilo|khub|ektu|ekta|ekhane|okhane|keno|ager|porer|ajke|kalke|prothom|last|first|somossa|shomosha|vul|bhul|bhang\w*|nosto|hoyto|somoy|proyash|corect|howa|hoy ?na|hoche ?na|hocche ?na)\b/i;

/** Romanized Hindi (Hinglish) — enough overlap with English that we only fire when there's
 *  a Hindi-specific token AND not a stronger Bengali signal. */
const HI_HINGLISH = /\b(kar(?:o|ie|na|oge|enge|te|ta|ti)?|karo|karna|karke|banay|banate|likho|likhna|samajh|samjha|samjhao|thik|hai|hain|nahi|nahin|kya|kaise|kyun|kyunki|kabhi|kab|kahan|kaisa|kaisi|aaj|kal|abhi|phir|tab|lekin|magar|aur|ya|nahi|hoga|hogi|honge|mujh|mujhe|tujhe|tum|aap|main|mera|tera|uska|iska|bahut|bohot|ek|do|teen|char|kuch|sab|koi|kaisa)\b/i;

/** Detect the language of a user message. Returns null for plain English / no signal — the
 *  caller appends nothing, and the model stays on its English default. Returns a short tag
 *  for non-English / mixed-language input. */
export function detectUserLanguage(text: string): DetectedLanguage | null {
  if (!text) return null;
  // Script check wins over romanized: a single Devanagari letter is a stronger signal than
  // any romanized token, and BN/HI Hinglish are noisy. Cyrillic + CJK scripts are also
  // unambiguous.
  for (const [lang, re] of NON_LATIN_SCRIPTS) {
    if (re.test(text)) return lang;
  }
  // Romanized detection — only after script check, only on the latest user text, only when
  // the script is Latin.
  if (BN_BANGLISH.test(text)) return 'en-banglish';
  if (HI_HINGLISH.test(text)) return 'en-hinglish';
  return null;
}

/** Short system-prompt tail for the detected language. Designed to be a stable, single-block
 *  addition that the model attends to without restating its main task. */
export function languageTail(lang: DetectedLanguage | null): string {
  if (!lang) return '';
  switch (lang) {
    case 'bn':
      return '## Response language\n'
        + 'The user wrote in Bengali (বাংলা). Reply in Bengali. Mirror their script choice '
        + '(Bangla script if they used it; romanized Banglish if they did not). Keep code, '
        + 'file paths, and command lines in their original (Latin) form.';
    case 'hi':
      return '## Response language\n'
        + 'The user wrote in Hindi (हिन्दी). Reply in Hindi. Mirror their script choice '
        + '(Devanagari if they used it; romanized Hinglish if they did not). Keep code, '
        + 'file paths, and command lines in their original (Latin) form.';
    case 'en-banglish':
      return '## Response language\n'
        + 'The user wrote in Romanized Bengali (Banglish). Reply in the same Banglish style — '
        + 'transliterated Bengali words in Latin script, not English. Do not translate their '
        + 'question into English before answering; answer what they asked, in their language. '
        + 'Keep code, file paths, and command lines in their original (Latin) form.';
    case 'en-hinglish':
      return '## Response language\n'
        + 'The user wrote in Romanized Hindi (Hinglish). Reply in the same Hinglish style — '
        + 'transliterated Hindi words in Latin script, not English. Do not translate their '
        + 'question into English before answering; answer what they asked, in their language. '
        + 'Keep code, file paths, and command lines in their original (Latin) form.';
    case 'ur':
      return '## Response language\n'
        + 'The user wrote in Urdu (اردو). Reply in Urdu, in Arabic/Nastaliq script. Keep code, '
        + 'file paths, and command lines in their original (Latin) form.';
    case 'ar':
      return '## Response language\n'
        + 'The user wrote in Arabic (العربية). Reply in Arabic. Keep code, file paths, and '
        + 'command lines in their original (Latin) form.';
    case 'fa':
      return '## Response language\n'
        + 'The user wrote in Persian/Farsi (فارسی). Reply in Persian, using the Perso-Arabic '
        + 'script. Keep code, file paths, and command lines in their original (Latin) form.';
    case 'zh':
      return '## Response language\n'
        + 'The user wrote in Chinese (中文). Reply in Chinese. Keep code, file paths, and '
        + 'command lines in their original (Latin) form.';
    case 'ja':
      return '## Response language\n'
        + 'The user wrote in Japanese (日本語). Reply in Japanese. Keep code, file paths, and '
        + 'command lines in their original (Latin) form.';
    case 'ko':
      return '## Response language\n'
        + 'The user wrote in Korean (한국어). Reply in Korean. Keep code, file paths, and '
        + 'command lines in their original (Latin) form.';
    case 'th':
      return '## Response language\n'
        + 'The user wrote in Thai (ไทย). Reply in Thai. Keep code, file paths, and command '
        + 'lines in their original (Latin) form.';
    case 'ta':
      return '## Response language\n'
        + 'The user wrote in Tamil (தமிழ்). Reply in Tamil. Keep code, file paths, and '
        + 'command lines in their original (Latin) form.';
    case 'ru':
      return '## Response language\n'
        + 'The user wrote in Russian (Русский). Reply in Russian, Cyrillic script. Keep code, '
        + 'file paths, and command lines in their original (Latin) form.';
  }
}
