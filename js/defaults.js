/* Every default the app falls back to: settings, prompts, the voice catalogue
   and the starter deck. Settings loaded from disk are merged over these, so an
   older settings.json keeps working and new keys appear with their defaults. */

/* Google's prebuilt Gemini TTS voices, with their one-word style label.
   Adding a voice is a one-line change here — the UI renders whatever is in
   this list. Order is canonical: it is how the ticked set is stored. */
export const VOICES = [
  ['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'],
  ['Kore', 'Firm'], ['Fenrir', 'Excitable'], ['Leda', 'Youthful'],
  ['Orus', 'Firm'], ['Aoede', 'Breezy'], ['Callirrhoe', 'Easy-going'],
  ['Autonoe', 'Bright'], ['Enceladus', 'Breathy'], ['Iapetus', 'Clear'],
  ['Umbriel', 'Easy-going'], ['Algieba', 'Smooth'], ['Despina', 'Smooth'],
  ['Erinome', 'Clear'], ['Algenib', 'Gravelly'], ['Rasalgethi', 'Informative'],
  ['Laomedeia', 'Upbeat'], ['Achernar', 'Soft'], ['Alnilam', 'Firm'],
  ['Schedar', 'Even'], ['Gacrux', 'Mature'], ['Pulcherrima', 'Forward'],
  ['Achird', 'Friendly'], ['Zubenelgenubi', 'Casual'],
  ['Vindemiatrix', 'Gentle'], ['Sadachbia', 'Lively'],
  ['Sadaltager', 'Knowledgeable'], ['Sulafat', 'Warm'],
];
export const VOICE_NAMES = VOICES.map(([name]) => name);

/* Sent to the text model. {placeholders} are filled by fillTemplate() in
   gemini.js; anything the user leaves in that we do not recognise is passed
   through untouched. The two output labels are what parseSentence() looks for,
   so they are the one part of this worth keeping when editing. */
export const DEFAULT_SENTENCE_PROMPT = `You are writing a single {language} dictation sentence for an {level} learner.
{languageNote}

Use ALL of these target words/phrases, exactly as written, in one natural sentence:
{terms}

Rules:
- Exactly ONE sentence, {minWords}-{maxWords} words. Natural, everyday, something a native speaker would actually say.
- Use only common everyday vocabulary besides the target words. No proper nouns, no place names, no personal names, no numbers written as digits.
- Every accent and diacritic must be correct — this sentence is the answer key for a dictation exercise.

Output exactly two lines and nothing else:
TARGET: <the {language} sentence>
EN: <its English translation>`;

/* Sent to the TTS model as the content to speak. Bare {sentence} is just the
   sentence read aloud; a prefix like "Read slowly and clearly: {sentence}"
   steers delivery, because Gemini TTS follows style instructions. */
export const DEFAULT_SPEECH_PROMPT = '{sentence}';

export const DEFAULT_SETTINGS = {
  targetLanguage: 'Vietnamese',
  learnerLevel: 'intermediate',
  languageNote: 'Southern register, everyday spoken style.',
  textModel: 'gemini-3.6-flash',
  ttsModel: 'gemini-3.1-flash-tts-preview',
  /* Google's free-tier limits. 0 means unlimited. Raise them for a paid key. */
  limits: { textRpm: 4, textRpd: 20, ttsRpm: 2, ttsRpd: 10 },
  termsPerSentence: 3,
  sentenceWords: { min: 8, max: 16 },
  prompts: { sentence: DEFAULT_SENTENCE_PROMPT, speech: DEFAULT_SPEECH_PROMPT },
  voices: VOICE_NAMES.slice(),
  fallbackVoice: 'Kore',
  typingDirection: 'random',
  /* Read the word being learnt aloud in Typing, with the browser's own voice. */
  typingSpeak: true,
  /* Name of the browser voice to read with; '' picks the best installed. */
  speechVoice: '',
  /* Which decks the practice tabs may draw from. Empty means "whichever deck
     is open" — the honest answer on a fresh install, where there is only one.
     The Flashcards tab keeps this list and never lets it empty out. */
  practiceDecks: [],
  theme: 'dark',
};

/* Shown on first run and written to decks/default.json when a folder with no
   decks is connected. Three cards, chosen to document the format: one being
   got wrong, one going well, one bare pair with no history at all.

   Their scores are what the rules would actually produce from their `recent`
   arrays — a hand-picked score that the first correct answer would overwrite
   downwards is a rotten thing to hand someone on their first minute. */
export const STARTER_DECK = [
  /* Being got wrong: a full window, one answer right out of eight. */
  {
    front: 'căn cứ',
    back: 'to base (a judgment) on, to rely on as grounds',
    notes: "căn = root, basis; cứ = to rely on, evidence. E.g. \"Không thể căn cứ vào bề ngoài để đánh giá một người.\" = \"You can't judge someone based on appearance alone.\"",
    score: 1,
    recent: [false, false, false, true, false, false, false, false],
    last_seen: '2026-09-22',
  },
  /* Going well: six right out of eight, which is what earns a 4. */
  {
    front: 'lời đề nghị',
    back: 'offer, proposal',
    notes: 'lời = words, statement; đề nghị = to propose, suggest. E.g. "Chị ấy từ chối lời đề nghị của anh ấy." = "She declined his offer."',
    score: 4,
    recent: [true, true, false, true, true, true, false, true],
    last_seen: '2026-09-20',
  },
  /* A bare pair with no history at all: everything below `notes` is filled in
     for you the first time it is answered. */
  {
    front: 'tiện lợi',
    back: 'convenient, handy (of an object/method)',
    notes: 'tiện = convenient; lợi = benefit. E.g. "Điện thoại thông minh rất tiện lợi." = "Smartphones are very convenient."',
  },
];

/* Merge loaded settings over the defaults, one level into the nested objects.
   Anything the user's file does not mention keeps its default. */
export function withDefaults(loaded) {
  const s = { ...DEFAULT_SETTINGS, ...(loaded || {}) };
  s.limits = { ...DEFAULT_SETTINGS.limits, ...((loaded && loaded.limits) || {}) };
  s.sentenceWords = { ...DEFAULT_SETTINGS.sentenceWords, ...((loaded && loaded.sentenceWords) || {}) };
  s.prompts = { ...DEFAULT_SETTINGS.prompts, ...((loaded && loaded.prompts) || {}) };
  /* Filter the ticked voices through the catalogue so a renamed or dropped
     voice cannot end up in a request. Never leave the pool empty. */
  const wanted = new Set(Array.isArray(s.voices) ? s.voices.map(String) : []);
  const enabled = VOICE_NAMES.filter((n) => wanted.has(n));
  s.voices = enabled.length ? enabled : [s.fallbackVoice || 'Kore'];
  /* Deck names only; which of them still exist is decided against the folder,
     not here, so a deck that is temporarily missing is not forgotten. */
  s.practiceDecks = Array.isArray(s.practiceDecks)
    ? [...new Set(s.practiceDecks.map(String).filter(Boolean))] : [];
  return s;
}
