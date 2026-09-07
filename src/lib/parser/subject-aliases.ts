/**
 * UTM prints a subject either in full ("Analiza matematică") or as the abbreviation the
 * chair uses in the grid ("AM"), sometimes both within one timetable. Expanding the
 * abbreviation gives every lesson one canonical `subject`; `raw_text` keeps the PDF's
 * own wording untouched.
 *
 * Resolution is an exact match on the whole cleaned subject – never a substring
 * replacement – so "AM" expands while "Amdaris" or "TWeb" are left exactly as printed,
 * and an abbreviation nobody confirmed ("MDPS", "RC") stays an abbreviation.
 */

/** Official abbreviations, expanded to the Romanian names UTM uses for the same courses. */
export const SUBJECT_ALIASES = new Map<string, string>([
  // Deliberately without a "1"/"2": the abbreviation never carries the semester, and the
  // bare name is what the timetable itself prints for both halves of the course.
  ["AM", "Analiza matematică"],
  ["ALGA", "Algebra liniară și geometria analitică"],
  ["PC", "Programarea calculatoarelor"],
  ["TP", "Tehnici de programare"],
  ["TPA", "Tehnici de programare aplicată"],
  ["CDE", "Circuite și dispozitive electronice"],
  ["ICPP", "Ingineria calculatoarelor și produse program"],
  ["ESU", "Etică și securitatea umană"],
  ["EIA", "Etică și integritate academică"],
  ["SSM", "Securitatea și sănătatea în muncă"],
  ["SSM.", "Securitatea și sănătatea în muncă"],
  ["MD", "Matematica discretă"],
  ["ÎS", "Introducere în specialitate"],
  ["PCAS", "Proiectarea conceptuală a unei aplicații software"],

  // Confirmed Anul II discipline abbreviations
  ["POO", "Programarea orientată pe obiecte"],
  ["MS", "Matematici speciale"],
  ["APA", "Analiza și proiectarea algoritmilor"],
  ["ASDN", "Analiza și sinteza dispozitivelor numerice"],
  ["ASCS", "Analiza și specificarea cerințelor software"],
  ["BD", "Baze de date"],
  ["BSD", "Bazele statului și dreptului"],
  ["SCC", "Structuri de calcul și de comunicare"],
  ["DEMTPI", "Dispozitive electronice și mijloace tehnice de protecție a informației"],
  ["CEI", "Circuite electronice integrate"],
  ["TSA", "Teoria sistemelor automate"],
  ["DNAC", "Dispozitive numerice și arhitecturi de calculatoare"],
  ["FCS", "Fizica corpului solid"],
  ["ME", "Măsurări electronice"],
  ["PADM", "Proiectarea asistată de calculator a dispozitivelor medicale"],
  ["PAE", "Proiectarea asistată în electronică"],
  ["AFU", "Anatomia și fiziologia umană"],

  // Confirmed global subject alias
  ["RC", "Rețele de calculatoare"],
]);

/**
 * Note on MDPS:
 * MDPS = "Matematică discretă, Probabilitate și statistică aplicată".
 * Combined timetable label for two disciplines separate in the study plan;
 * intentionally preserved as the abbreviation "MDPS" for display per user preference.
 */

/**
 * Abbreviations misspelled or truncated in timetables: e.g. "ESM" is ESU and "SMM" is SSM.
 * Kept apart from the official dataset on purpose – these are PDF typos/variants, not
 * official abbreviations UTM publishes. Nothing here guesses: an unknown lookalike stays as printed.
 */
export const KNOWN_SUBJECT_TYPO_ALIASES = new Map<string, string>([
  ["ESM", "Etică și securitatea umană"],
  ["SMM", "Securitatea și sănătatea în muncă"],
  ["Tehnici de pogramare aplicată", "Tehnici de programare aplicată"],

  // Confirmed Anul II spelling and truncation variants
  ["Progromarea Orientată pe Obiecte", "Programarea orientată pe obiecte"],
  ["Programarea Orientată pe Obiect", "Programarea orientată pe obiecte"],
  ["Filosogie și gândire inginerească", "Filosofie și gândire inginerească"],
  ["DMETPI", "Dispozitive electronice și mijloace tehnice de protecție a informației"],
  ["DMTPI", "Dispozitive electronice și mijloace tehnice de protecție a informației"],
  ["DAAC", "Dispozitive numerice și arhitecturi de calculatoare"],
  ["AFV", "Anatomia și fiziologia umană"],
  ["Dispoz. ElecT. MTPI", "Dispozitive electronice și mijloace tehnice de protecție a informației"],
  ["Struct. Calc. și Comun.", "Structuri de calcul și de comunicare"],
  ["Măsurări Electr.", "Măsurări electronice"],
  ["Analiza și Specif. Software", "Analiza și specificarea cerințelor software"],
  ["Filosofia GC", "Filosofie și gândire critică"],
  ["Filosofie GC", "Filosofie și gândire critică"],
  ["Filosofia GI", "Filosofie și gândire inginerească"],
  ["Filosofie GI", "Filosofie și gândire inginerească"],
  ["Filosofie și gand. ing.", "Filosofie și gândire inginerească"],
  ["SCS", "Structuri de calcul și de comunicare"],
]);

/**
 * "EA" means two different things in one timetable: the subject *Engleza în afaceri* that
 * the FAF groups take, and the code of the *Electronică aplicată* speciality that names the
 * EA-26x columns. It is expanded only for the groups it is a subject for.
 */
const GROUP_SCOPED_ALIASES: { alias: string; expansion: string; groups: RegExp }[] = [
  { alias: "EA", expansion: "Engleza în afaceri", groups: /^FAF-/i },
];

/**
 * Expand a subject abbreviation to its canonical name, or return it unchanged.
 * `groups` are the group columns the lesson belongs to, needed only by the aliases that
 * mean different things for different specialities.
 */
export function resolveSubjectAlias(subject: string, groups: readonly string[] = []): string {
  const key = subject.trim();
  if (!key) return subject;

  const scoped = GROUP_SCOPED_ALIASES.find((entry) => entry.alias === key);
  if (scoped) return groups.some((group) => scoped.groups.test(group)) ? scoped.expansion : subject;

  return SUBJECT_ALIASES.get(key) ?? KNOWN_SUBJECT_TYPO_ALIASES.get(key) ?? subject;
}
