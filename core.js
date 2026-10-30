/* Логика без интерфейса: случайные числа, колода, прогресс.
   Один и тот же файл работает в браузере (window.Core) и в тестах Node (require). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Core = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------- честный случай ---------- */

  // Целое из [0, n) без перекоса. Math.random годится плохо, а «% n» от случайного uint32
  // даёт лишнюю вероятность младшим числам, если 2^32 не делится на n нацело. Поэтому числа
  // из неполного «хвоста» диапазона отбрасываются и берутся заново (rejection sampling).
  function randomInt(n, rng) {
    if (!Number.isInteger(n) || n <= 0) throw new RangeError("randomInt: n должно быть целым > 0");
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / n) * n; // наибольшее кратное n, не превышающее 2^32
    let x;
    do {
      (rng || crypto).getRandomValues(buf);
      x = buf[0];
    } while (x >= limit);
    return x % n;
  }

  // Тасование Фишера — Йетса: каждая из n! перестановок равновероятна, если randomInt честный.
  function shuffle(items, rng) {
    const a = items.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = randomInt(i + 1, rng);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* ---------- колода ---------- */

  // Каждая подходящая карточка выпадает ровно один раз за круг; когда круг кончился, колода
  // тасуется заново из того, что подходит сейчас («Повторить» остаётся, «Знаю», «Не учим» и «Верно» — нет).
  // Подряд одна карточка не выпадает: если новый круг начался с только что показанной,
  // она меняется местами со случайной другой — это единственное отступление от чистого
  // тасования, и тест проверяет, что перекоса по карточкам оно не даёт.
  class Deck {
    constructor(getEligible, rng) {
      this.getEligible = getEligible; // () => массив id, подходящих сейчас
      this.rng = rng;
      this.queue = [];
      this.last = null;
      this.round = 0;
    }
    reset() {
      this.queue = [];
      this.round = 0;
    }
    next() {
      const eligible = new Set(this.getEligible());
      if (eligible.size === 0) return null;
      // из очереди выбрасывается то, что перестало подходить (отмечено «Знаю», снят уровень)
      while (this.queue.length && !eligible.has(this.queue[0])) this.queue.shift();
      if (!this.queue.length) {
        this.queue = shuffle([...eligible], this.rng);
        this.round++;
        if (this.queue.length > 1 && this.queue[0] === this.last) {
          const j = 1 + randomInt(this.queue.length - 1, this.rng);
          [this.queue[0], this.queue[j]] = [this.queue[j], this.queue[0]];
        }
      }
      const id = this.queue.shift();
      this.last = id;
      return id;
    }
  }

  /* ---------- прогресс ---------- */

  const STORAGE_KEY = "greek-verbs.progress";
  const FORMAT = "greek-verbs-progress";
  const VERSION = 1;
  const LEVELS = ["A1", "A2", "B1"];
  // Типы спряжения по учебникам; ΑΒ — смешанные (ακούω, λέω, πάω…), Γ1–Γ4 — окончания страдательных
  // «особые» — глаголы без типа в словаре: είμαι и безличные (πρέπει, συμβαίνει…). Без своей
  // кнопки они не прошли бы ни через один выбор типов и исчезли бы из колоды молча.
  const OTHER_TYPE = "особые";
  const TYPES = ["Α", "ΑΒ", "Β1", "Β2", "Γ1", "Γ2", "Γ3", "Γ4", OTHER_TYPE];
  const typeOf = (v) => (TYPES.includes(v.type) ? v.type : OTHER_TYPE);
  const DIRS = ["gr-ru", "ru-gr"];
  const FLOWS = ["steps", "all", "random"]; // «По шагам», «Всё сразу», «Рандом»

  // Справочник: буква указателя — первая буква слова без ударения и диалитики, заглавная (έχω → Ε, ϊ → Ι)
  const GREEK_ABC = "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ".split("");
  const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const letterOf = (word) => fold(word).charAt(0).toUpperCase();

  // «γράφουν(ε)» — необязательное -ε, как пишут учебники (ставит сборка, scripts/forms.py). Для поиска это обе
  // формы, для озвучки — короткая: скобку голос прочитал бы буквально
  // «θα βγουν / θα βγούνε» — там, где скобка не годится (с -ε появляется ударение): поиску обе, голосу первая
  const OPT_E = "(ε)";
  const ALT = " / ";
  const formVariants = (f) => (!f ? [] : f.includes(ALT) ? f.split(ALT).flatMap(formVariants)
    : f.endsWith(OPT_E) ? [f.slice(0, -OPT_E.length), f.slice(0, -OPT_E.length) + "ε"] : [f]);
  const speakable = (s) => String(s || "").split(ALT)[0].split(OPT_E).join("");
  const TENSES = ["present", "past", "future"];

  // Во вкладках форм учёт ведётся по отдельной форме, а не по глаголу: «present:γράφω:3» — «γράφουμε».
  // Время в начале — чтобы один учёт служил всем вкладкам форм.
  const formId = (tense, verb, person) => `${tense}:${verb}:${person}`;
  function parseFormId(id) {
    const m = typeof id === "string" && /^([a-z]+):(.+):([0-5])$/.exec(id);
    if (!m || !TENSES.includes(m[1])) return null;
    return { tense: m[1], verb: m[2], person: Number(m[3]) };
  }

  // Усвоение: сколько раз форма отвечена «Верно». Хранится только счёт, а «освоено» считается на лету
  // (счёт ≥ порога) — тогда смена порога сразу и честно перекладывает формы, без второго списка.
  const GOAL_DEFAULT = 5;
  const GOAL_MIN = 1;
  const GOAL_MAX = 20;
  const isMastered = (progress, dir, id) => (progress.correct[dir][id] || 0) >= progress.settings.masteryGoal;

  function emptyProgress() {
    return {
      format: FORMAT,
      version: VERSION,
      settings: { levels: LEVELS.slice(), types: TYPES.slice(), dir: "gr-ru", theme: "auto", tab: "present1",
                  mastery: true, masteryGoal: GOAL_DEFAULT, textbook: true, flow: "steps" },
      known: { "gr-ru": [], "ru-gr": [] },
      skip: [],
      correct: { "gr-ru": {}, "ru-gr": {} },
    };
  }

  // Принимает что угодно (localStorage, файл пользователя) и возвращает правильный прогресс.
  // Лишнее отбрасывается, недостающее берётся по умолчанию; неизвестные глаголы считаются,
  // но не теряются молча — вызывающий получает их число.
  function normalize(raw, knownVerbs) {
    const p = emptyProgress();
    const report = { unknown: 0 };
    if (!raw || typeof raw !== "object") return { progress: p, report };
    const s = raw.settings || {};
    if (Array.isArray(s.levels)) {
      const lv = LEVELS.filter((l) => s.levels.includes(l));
      if (lv.length) p.settings.levels = lv;
    }
    // В старом прогрессе типов нет — тогда выбраны все, как было до фильтра
    if (Array.isArray(s.types)) {
      const tp = TYPES.filter((t) => s.types.includes(t));
      if (tp.length) p.settings.types = tp;
    }
    if (DIRS.includes(s.dir)) p.settings.dir = s.dir;
    if (["auto", "light", "dark"].includes(s.theme)) p.settings.theme = s.theme;
    if (typeof s.tab === "string") p.settings.tab = s.tab;
    if (typeof s.mastery === "boolean") p.settings.mastery = s.mastery;
    // режим курса «Ελληνικά Τώρα 1+1»: в старом прогрессе его нет — тогда включён, как у нового человека
    if (typeof s.textbook === "boolean") p.settings.textbook = s.textbook;
    // «steps» — во вкладках времён только слова из «Знаю»; «all» — все глаголы под фильтрами; «random» — то же, без вкладок
    if (FLOWS.includes(s.flow)) p.settings.flow = s.flow;
    if (Number.isInteger(s.masteryGoal)) p.settings.masteryGoal = Math.min(GOAL_MAX, Math.max(GOAL_MIN, s.masteryGoal));
    const clean = (list) => {
      if (!Array.isArray(list)) return [];
      const out = [];
      for (const v of list) {
        if (typeof v !== "string") continue;
        if (knownVerbs && !knownVerbs.has(v)) { report.unknown++; continue; }
        if (!out.includes(v)) out.push(v);
      }
      return out;
    };
    const known = raw.known || {};
    p.known["gr-ru"] = clean(known["gr-ru"]);
    p.known["ru-gr"] = clean(known["ru-gr"]);
    p.skip = clean(raw.skip);
    // Счёт «Верно» по формам. Испорченная запись отбрасывается, запись про неизвестный глагол
    // считается вместе с остальными неизвестными
    const take = (dir, id, n) => {
      const f = parseFormId(id);
      if (!f || !Number.isInteger(n) || n < 1) return;
      if (knownVerbs && !knownVerbs.has(f.verb)) { report.unknown++; return; }
      p.correct[dir][id] = Math.max(p.correct[dir][id] || 0, Math.min(n, 999));
    };
    const correct = raw.correct || {};
    // прежний формат хранил список «Освоено» — такие формы получают счёт, равный порогу: они остаются освоенными
    const mastered = raw.mastered || {};
    for (const dir of DIRS) {
      const c = correct[dir];
      if (c && typeof c === "object" && !Array.isArray(c)) for (const [id, n] of Object.entries(c)) take(dir, id, n);
      if (Array.isArray(mastered[dir])) for (const id of mastered[dir]) take(dir, id, p.settings.masteryGoal);
    }
    return { progress: p, report };
  }

  // Файл для переноса прогресса: тот же формат, плюс дата — чтобы было видно, какой файл свежее.
  function toExport(progress) {
    return JSON.stringify({ ...progress, exported: new Date().toISOString() }, null, 2);
  }

  function fromImport(text, knownVerbs) {
    let raw;
    try { raw = JSON.parse(text); } catch (e) { throw new Error("Это не файл прогресса: не удалось прочитать JSON."); }
    if (!raw || raw.format !== FORMAT) throw new Error("Это не файл прогресса тренажёра.");
    if (raw.version > VERSION) throw new Error("Файл сохранён более новой версией тренажёра.");
    return normalize(raw, knownVerbs);
  }

  return { randomInt, shuffle, Deck, emptyProgress, normalize, toExport, fromImport,
           typeOf, OTHER_TYPE, STORAGE_KEY, LEVELS, TYPES, DIRS, FLOWS, TENSES, formId, parseFormId,
           isMastered, GOAL_MIN, GOAL_MAX, GOAL_DEFAULT, GREEK_ABC, fold, letterOf, formVariants, speakable };
});
