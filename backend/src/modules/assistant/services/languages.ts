/** Languages the assistant can talk in. `speech` is the BCP-47 tag the browser's voice recognition and voice synthesis use. */
export const LANGUAGES = [
  { code: "en", name: "English", native: "English", speech: "en-IN" },
  { code: "hi", name: "Hindi", native: "हिन्दी", speech: "hi-IN" },
  { code: "bn", name: "Bengali", native: "বাংলা", speech: "bn-IN" },
  { code: "ta", name: "Tamil", native: "தமிழ்", speech: "ta-IN" },
  { code: "te", name: "Telugu", native: "తెలుగు", speech: "te-IN" },
  { code: "mr", name: "Marathi", native: "मराठी", speech: "mr-IN" },
  { code: "gu", name: "Gujarati", native: "ગુજરાતી", speech: "gu-IN" },
  { code: "kn", name: "Kannada", native: "ಕನ್ನಡ", speech: "kn-IN" },
  { code: "ml", name: "Malayalam", native: "മലയാളം", speech: "ml-IN" },
  { code: "pa", name: "Punjabi", native: "ਪੰਜਾਬੀ", speech: "pa-IN" },
  { code: "ur", name: "Urdu", native: "اردو", speech: "ur-IN" },
  { code: "es", name: "Spanish", native: "Español", speech: "es-ES" },
  { code: "fr", name: "French", native: "Français", speech: "fr-FR" },
  { code: "ar", name: "Arabic", native: "العربية", speech: "ar-SA" },
] as const;
export type LangCode = (typeof LANGUAGES)[number]["code"];
export const LANG_CODES = LANGUAGES.map((l) => l.code) as [LangCode, ...LangCode[]];
export const langName = (c: string) => LANGUAGES.find((l) => l.code === c)?.name ?? "English";
