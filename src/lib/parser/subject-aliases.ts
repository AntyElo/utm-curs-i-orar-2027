/**
 * UTM prints a subject either in full ("Analiza matematică") or as the abbreviation the
 * chair uses in the grid ("AM"), sometimes both within one timetable. Expanding the
 * abbreviation gives every lesson one canonical `subject`; `raw_text` keeps the PDF's
 * own wording untouched.
 * Resolution is an exact match on the whole cleaned subject – never a substring
 * replacement – so "AM" expands while "Amdaris" or "TWeb" are left exactly as printed,
 * and an abbreviation nobody confirmed stays an abbreviation.
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

  // Confirmed global subject aliases
  ["RC", "Rețele de calculatoare"],
  ["MDPS", "Matematică discretă, probabilitate și statistică aplicată"],

  // Confirmed language expansions
  ["L. Engleză", "Limba engleză"],
  ["L.Engleză", "Limba engleză"],
  ["L. engleză", "Limba engleză"],
  ["L. Română", "Limba română"],
  ["L.Română", "Limba română"],
  ["L. Străină", "Limba străină"],
  ["L. Engleză 1", "Limba engleză"],
  ["L.Engleza 1", "Limba engleză"],
  ["L. Engleză A1", "Limba engleză A1"],
  ["L.Engleză A1", "Limba engleză A1"],
  ["L. engleză A1", "Limba engleză A1"],
]);

/**
 * Abbreviations misspelled or truncated in timetables: e.g. "ESM" is ESU and "SMM" is SSM.
 * Kept apart from the official dataset on purpose – these are PDF typos/variants, not
 * official abbreviations UTM publishes. Nothing here guesses: an unknown lookalike stays as printed.
 */
export const KNOWN_SUBJECT_TYPO_ALIASES = new Map<string, string>([
  ["ESM", "Etică și securitatea umană"],
  ["SMM", "Securitatea și sănătatea în muncă"],
  ["Tehnici de pogramare aplicată", "Tehnici de programare aplicată"],
  // A misplaced space in anul_i_semestrul_i-16.pdf ("Tehnici d eprogramare"). Corrected as
  // one exact string, not by repairing spaces generally: only this wording is confirmed.
  ["Tehnici d eprogramare", "Tehnici de programare"],

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
  ["Filosofia și Gândire Critică", "Filosofie și gândire critică"],
  ["Filosofia și gândire critică", "Filosofie și gândire critică"],
  ["Filosofia și Gândirea Critică", "Filosofie și gândire critică"],
  ["Filosofia și gândirea critică", "Filosofie și gândire critică"],
  ["Filosofia GI", "Filosofie și gândire inginerească"],
  ["Filosofie GI", "Filosofie și gândire inginerească"],
  ["Filosofie și gand. ing.", "Filosofie și gândire inginerească"],
  ["SCS", "Structuri de calcul și de comunicare"],

  // Embedded SI subject abbreviation (not global SI code)
  ["Cadrul Legal al SI", "Cadrul Legal al Securității Informaționale"],
  ["Cadrul legal al SI", "Cadrul Legal al Securității Informaționale"],

  // Language typo / truncation variants
  ["L. Rom.", "Limba română"],
  ["L.Rom", "Limba română"],

  // Confirmed whole-subject canonical mappings
  // 1. Dreptul de Proprietate Intelectuală → Dreptul Proprietății Intelectuale
  ["Dreptul de Proprietate Intelectuală", "Dreptul proprietății intelectuale"],
  ["Dreptul de proprietate intelectuală", "Dreptul proprietății intelectuale"],

  // 2. Proiectarea Conceptelor AS → Proiectarea conceptuală a unei aplicații software
  ["Proiectarea Conceptelor AS", "Proiectarea conceptuală a unei aplicații software"],
  ["Proiectarea conceptelor AS", "Proiectarea conceptuală a unei aplicații software"],

  // 3. Circuite și Dispozitive Electrice → Circuite și dispozitive electronice
  ["Circuite și Dispozitive Electrice", "Circuite și dispozitive electronice"],
  ["Circuite și dispozitive electrice", "Circuite și dispozitive electronice"],

  // 4. Ed. Fizică → Educație fizică
  ["Ed. Fizică", "Educație fizică"],
  ["Ed. fizică", "Educație fizică"],
  // The articulated spelling one cell of anul_i_semestrul_i-16.pdf uses for the same
  // discipline; the UTM curriculum names it "Educație fizică".
  ["Educația fizică", "Educație fizică"],

  // 5. Fizica → Fizică
  ["Fizica", "Fizică"],
  ["fizica", "Fizică"],

  // 6. Algebră Liniară și Geometrie Analitică → Algebra liniară și geometria analitică
  ["Algebră Liniară și Geometrie Analitică", "Algebra liniară și geometria analitică"],
  ["Algebră liniară și geometrie analitică", "Algebra liniară și geometria analitică"],

  // 7. Etica și Integritatea Academică → Etică și integritate academică
  ["Etica și Integritatea Academică", "Etică și integritate academică"],
  ["Etica și integritatea academică", "Etică și integritate academică"],

  // 8. Security/ethics variants → Etică și securitatea umană
  ["Etica și Securitate Umană", "Etică și securitatea umană"],
  ["Etica și securitate umană", "Etică și securitatea umană"],
  ["Etica și Securitate umană", "Etică și securitatea umană"],
  ["Etică și Securitate Umană", "Etică și securitatea umană"],
  ["Etică și securitate umană", "Etică și securitatea umană"],
  ["Etică și Securitate umană", "Etică și securitatea umană"],
  ["Etica și Securitatea Umană", "Etică și securitatea umană"],
  ["Etica și securitatea umană", "Etică și securitatea umană"],
  ["Etica și Securitatea umană", "Etică și securitatea umană"],
  ["Etică și Securitatea Umană", "Etică și securitatea umană"],
  ["Etică și Securitatea umană", "Etică și securitatea umană"],

  // 9. Formatting normalization
  ["Activități Individuale/ În Grup", "Activități Individuale/În Grup"],
  ["Activități individuale/ în grup", "Activități Individuale/În Grup"],

  // 10. Erroneous semester marker in language subject
  ["Limba Engleză 1", "Limba engleză"],
  ["Limba engleză 1", "Limba engleză"],
  ["Limba Engleza 1", "Limba engleză"],
  ["Limba engleza 1", "Limba engleză"],
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
 * Recognized prefix/suffix decorations around subject abbreviations:
 * e.g. "1) CDE", "2) MS", "PAE 1/l", "PADM 1/e".
 * Preserves the exact decoration marker while expanding only the confirmed central alias core.
 */
const DECORATED_ALIAS_RE = /^(?:(\d+\)\s*))?([A-Za-zĂÂÎȘȚăâîșț0-9.-]+)(?:\s+((?:1\/[le]|\d+\/[a-z]+)))?$/;

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

  const direct = SUBJECT_ALIASES.get(key) ?? KNOWN_SUBJECT_TYPO_ALIASES.get(key);
  if (direct) return direct;

  const match = DECORATED_ALIAS_RE.exec(key);
  if (match) {
    const [, prefix = "", core, suffix = ""] = match;
    if (prefix || suffix) {
      const coreExpansion = resolveSubjectAlias(core, groups);
      if (coreExpansion !== core) {
        return `${prefix}${coreExpansion}${suffix ? ` ${suffix}` : ""}`;
      }
    }
  }

  return subject;
}
