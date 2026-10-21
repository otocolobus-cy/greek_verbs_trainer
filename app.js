/* Интерфейс тренажёра. Логика случая, колоды и прогресса — в core.js. Словарь (verbs.js) только читается. */
(function () {
  "use strict";

  const VERBS = window.VERBS || [];
  const byVerb = new Map(VERBS.map((v) => [v.verb, v]));
  const allVerbs = new Set(byVerb.keys());
  // одинаковый перевод у разных глаголов (κολυμπάω / κολυμπώ, διαλέγω / επιλέγω): при RU → GR верны все
  const byRu = new Map();
  for (const v of VERBS) {
    if (!byRu.has(v.ru)) byRu.set(v.ru, []);
    byRu.get(v.ru).push(v.verb);
  }

  const $ = (id) => document.getElementById(id);
  let started = false; // голоса приходят асинхронно — до старта перерисовывать ещё нечего

  /* ---------- вкладки ---------- */
  // Следующие режимы работают только со словами из «Знаю» (в любом направлении);
  // пока такого слова нет — вкладка недоступна и объясняет почему.
  const TABS = [
    { id: "present1", title: "Настоящее", sub: "я", ready: true },
    { id: "present-all", title: "Настоящее", sub: "все лица", ready: true, needsKnown: true, tense: "present" },
    { id: "past1", title: "Аорист", sub: "я", ready: true, needsKnown: true, tense: "past", first: true },
    { id: "past-all", title: "Аорист", sub: "все лица", ready: true, needsKnown: true, tense: "past" },
    { id: "future1", title: "Будущее простое", sub: "я", ready: true, needsKnown: true, tense: "future", first: true },
    { id: "future-all", title: "Будущее простое", sub: "все лица", ready: true, needsKnown: true, tense: "future" },
    // справочник ничего не учит: ни колоды, ни счётчика, ни «Знаю». В ряд вкладок не рисуется — его кнопка в шапке
    // (в ряду он перекрывал или выталкивал последнюю вкладку), но выбирается тем же selectTab
    { id: "ref", title: "Справочник", sub: "", ready: true, ref: true },
  ];

  /* ---------- прогресс ---------- */
  let storageOk = true;
  function loadProgress() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(Core.STORAGE_KEY) || "null"); }
    catch (e) { storageOk = false; }
    return Core.normalize(raw, allVerbs).progress;
  }
  let P = loadProgress();
  function save() {
    try {
      localStorage.setItem(Core.STORAGE_KEY, JSON.stringify(P));
      storageOk = true;
    } catch (e) {
      storageOk = false;
    }
    $("storage-warning").hidden = storageOk;
  }
  const sets = () => ({
    known: { "gr-ru": new Set(P.known["gr-ru"]), "ru-gr": new Set(P.known["ru-gr"]) },
    skip: new Set(P.skip),
  });
  const knownAny = () => new Set([...P.known["gr-ru"], ...P.known["ru-gr"]]);

  /* ---------- тема ---------- */
  const THEMES = { auto: ["◐", "Тема: как в системе"], light: ["☀", "Тема: светлая"], dark: ["☾", "Тема: тёмная"] };
  function applyTheme() {
    const t = P.settings.theme;
    if (t === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    const [icon, label] = THEMES[t];
    const b = $("theme-btn");
    b.textContent = icon;
    b.title = label + " (нажмите, чтобы сменить)";
    b.setAttribute("aria-label", label);
  }
  $("theme-btn").addEventListener("click", () => {
    const order = ["auto", "light", "dark"];
    P.settings.theme = order[(order.indexOf(P.settings.theme) + 1) % order.length];
    applyTheme();
    save();
  });

  /* ---------- озвучка ---------- */
  let greekVoice = null;
  const synth = window.speechSynthesis;
  function pickVoice() {
    if (!synth) return;
    const voices = synth.getVoices();
    greekVoice = voices.find((v) => /^el(-|_|$)/i.test(v.lang)) || null;
    $("voice-note").textContent = greekVoice
      ? `Озвучка: голос «${greekVoice.name}».`
      : "Голос для греческого в системе не найден, поэтому кнопки озвучки скрыты. Его можно добавить в настройках системы (раздел «Устная речь» / «Озвучивание текста»), затем перезагрузить страницу.";
    if (started) renderCard();
  }
  if (synth) {
    pickVoice();
    synth.addEventListener?.("voiceschanged", pickVoice);
  } else {
    $("voice-note").textContent = "Этот браузер не умеет озвучивать текст, кнопки озвучки скрыты.";
  }
  function speak(text) {
    if (!synth || !greekVoice || !text) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(Core.speakable(text)); // «γράφουν(ε)» читается как «γράφουν»
    u.voice = greekVoice;
    u.lang = greekVoice.lang;
    u.rate = 0.9;
    synth.speak(u);
  }

  /* ---------- вкладки: отрисовка ---------- */
  let lastTab = TABS[0].id; // последнее упражнение — туда возвращает повторное нажатие на «Справочник»
  // «Всё сразу»: вкладкам времён «Знаю» не нужно — они берут все глаголы под фильтрами
  const allAtOnce = () => P.settings.flow === "all";
  const isLocked = (t) => ((t.needsKnown && !allAtOnce()) || !t.ready) && knownAny().size === 0;
  // «все лица» работают с формами, первая вкладка — с глаголами
  const formsMode = () => !!(TABS.find((t) => t.id === P.settings.tab) || {}).tense;

  function renderTabs() {
    const nav = $("tabs");
    nav.textContent = "";
    for (const t of TABS) {
      if (t.ref) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tab";
      b.id = "tab-" + t.id;
      b.setAttribute("role", "tab");
      b.dataset.tab = t.id;
      b.setAttribute("aria-selected", String(P.settings.tab === t.id));
      const locked = isLocked(t);
      if (locked) {
        b.setAttribute("aria-disabled", "true");
        b.title = "Сначала отметьте хотя бы одно слово «Знаю» во вкладке «Настоящее · я»";
      }
      // первая вкладка — источник: её «Знаю» наполняет все остальные упражнения. В «Всё сразу» источника нет,
      // и стрелка от неё врала бы
      if (t.id === TABS[0].id && !allAtOnce()) {
        b.classList.add("tab-source");
        if (!locked) b.title = "Отсюда слова, отмеченные «Знаю», попадают во все остальные упражнения";
      }
      b.append(t.title);
      const s = document.createElement("small");
      const n = document.createElement("span");
      n.className = "tab-count";
      n.id = "count-" + t.id;
      s.append(t.sub, n);
      b.append(s);
      b.addEventListener("click", () => { if (!locked) selectTab(t.id); });
      nav.append(b);
    }
    if (started) renderTabCounts();
  }
  // Сколько карточек ещё не разложено — для текущего направления и фильтров; у закрытых и будущих вкладок числа нет
  function renderTabCounts() {
    for (const t of TABS) {
      const n = $("count-" + t.id);
      if (!n) continue;
      const left = !t.ready || isLocked(t) ? null : t.tense ? eligibleFormsFor(t).length : eligible().length;
      n.textContent = left == null ? "" : ` · ${left}`;
      n.title = left == null ? "" : `осталось карточек: ${left}`;
    }
  }
  function selectTab(id) {
    const tab = TABS.find((t) => t.id === id) || TABS[0];
    const target = isLocked(tab) ? TABS[0] : tab;
    const changed = P.settings.tab !== target.id;
    P.settings.tab = target.id;
    save();
    renderTabs();
    // рабочие вкладки делят одну панель: фильтры и направление общие, колода у каждой своя
    $("panel-present1").hidden = !target.ready || !!target.ref;
    $("panel-present1").setAttribute("aria-labelledby", "tab-" + target.id);
    $("panel-later").hidden = !!target.ready;
    $("panel-ref").hidden = !target.ref;
    $("ref-btn").setAttribute("aria-pressed", String(!!target.ref));
    if (!target.ref) lastTab = target.id; // повторное нажатие на «Справочник» вернёт сюда
    $("dir").hidden = !!target.ref; // направление справочнику ни к чему: он показывает обе стороны сразу
    if (target.ref) renderRef();
    if (!target.ready) {
      $("later-title").textContent = `${target.title} · ${target.sub} — в разработке`;
      $("later-text").textContent =
        `Здесь будет тренажёр: ${target.about}. Он будет работать со словами из списка «Знаю» — сейчас их ${knownAny().size}.`;
    }
    if (started && changed && target.ready && !target.ref) restartDeck();
  }

  /* ---------- фильтры ---------- */
  // Подсказки к типам спряжения: буквы Α/Β совпадают с уровнями A/B, и без окончания
  // и примера «Β1» в списке читалось бы как уровень знаний
  const TYPE_HINTS = {
    "Α": "-ω · γράφω, αλλάζω",
    "ΑΒ": "смешанные · ακούω, λέω, πάω",
    "Β1": "-άω · αγαπάω, απαντάω",
    "Β2": "-ώ · μπορώ, δημιουργώ",
    "Γ1": "-ομαι · έρχομαι, γίνομαι",
    "Γ2": "-άμαι · θυμάμαι, φοβάμαι",
    "Γ3": "-ιέμαι · στεναχωριέμαι",
    "Γ4": "-ούμαι · αρνούμαι",
    [Core.OTHER_TYPE]: "είμαι и безличные · πρέπει",
  };
  const LEVEL_HINTS = { A1: "начальный", A2: "базовый", B1: "средний" };

  // Уровень и спряжение устроены одинаково: выпадающий список с галочками,
  // всё выбрано по умолчанию, последнюю галочку не снять
  const FILTERS = [
    { id: "ms-levels", key: "levels", all: Core.LEVELS, hints: LEVEL_HINTS, of: (v) => v.level,
      last: "Хотя бы один уровень должен остаться выбранным" },
    { id: "ms-types", key: "types", all: Core.TYPES, hints: TYPE_HINTS, of: (v) => Core.typeOf(v),
      last: "Хотя бы одно спряжение должно остаться выбранным" },
  ];
  function filterValue(f) {
    const sel = P.settings[f.key];
    if (sel.length === f.all.length) return "все";
    return sel.length <= 3 ? sel.join(", ") : `${sel.length} из ${f.all.length}`;
  }
  function renderFilter(f) {
    const root = $(f.id);
    root.querySelector(".ms-value").textContent = filterValue(f);
    const pop = root.querySelector(".ms-pop");
    pop.textContent = "";
    const sel = P.settings[f.key];
    for (const x of f.all) {
      const on = sel.includes(x);
      const row = document.createElement("label");
      row.className = "ms-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = on;
      // последнюю галочку не снять — объясняем, а не молчим
      if (on && sel.length === 1) { cb.disabled = true; row.title = f.last; }
      cb.addEventListener("change", () => {
        const cur = P.settings[f.key];
        if (!cb.checked && cur.length === 1) { cb.checked = true; return; } // пустой выбор запрещён
        P.settings[f.key] = cb.checked ? f.all.filter((y) => y === x || cur.includes(y)) : cur.filter((y) => y !== x);
        save();
        renderFilter(f);
        renderCourse();
        restartDeck();
        pop.querySelectorAll("input")[f.all.indexOf(x)]?.focus();
      });
      const name = document.createElement("span");
      name.className = "ms-name";
      name.textContent = x;
      if (f.key === "types" && x !== Core.OTHER_TYPE) name.lang = "el";
      const hint = document.createElement("span");
      hint.className = "ms-hint";
      hint.textContent = f.hints[x] || "";
      const n = document.createElement("span");
      n.className = "ms-count";
      n.textContent = VERBS.filter((v) => f.of(v) === x && inCourse(v)).length;
      row.append(cb, name, hint, n);
      pop.append(row);
    }
    const all = document.createElement("button");
    all.type = "button";
    all.className = "btn-link ms-all";
    all.textContent = "Выбрать все";
    all.hidden = sel.length === f.all.length;
    all.addEventListener("click", () => {
      P.settings[f.key] = f.all.slice();
      save();
      renderFilter(f);
      renderCourse();
      restartDeck();
    });
    pop.append(all);
  }
  function renderLevels() {
    FILTERS.forEach(renderFilter);
    renderCourse();
  }

  // Курс «Ελληνικά Τώρα 1+1» — набор, внутри которого действуют уровень и спряжение.
  // Числа на половинках — сколько глаголов даст каждая при нынешних уровне и спряжении
  const inCourse = (v) => !P.settings.textbook || !!v.textbook;
  function renderCourse() {
    const inFilters = VERBS.filter((v) => P.settings.levels.includes(v.level) && P.settings.types.includes(Core.typeOf(v)));
    const n = { on: inFilters.filter((v) => v.textbook).length, off: inFilters.length };
    for (const b of $("course").querySelectorAll("button")) {
      const on = b.dataset.course === "on";
      b.setAttribute("aria-checked", String(on === P.settings.textbook));
      b.querySelector(".seg-n").textContent = `· ${n[b.dataset.course]}`;
      b.onclick = () => {
        if (P.settings.textbook === on) return;
        P.settings.textbook = on;
        save();
        FILTERS.forEach(renderFilter); // числа в списках уровня и спряжения — внутри выбранного набора
        renderCourse();
        renderTabs();
        restartDeck();
      };
    }
  }
  function openFilter(id) {
    for (const f of FILTERS) {
      const root = $(f.id);
      const open = f.id === id && root.querySelector(".ms-pop").hidden;
      root.querySelector(".ms-pop").hidden = !open;
      root.querySelector(".ms-btn").setAttribute("aria-expanded", String(open));
    }
  }
  const filterOpen = () => FILTERS.some((f) => !$(f.id).querySelector(".ms-pop").hidden);
  for (const f of FILTERS) $(f.id).querySelector(".ms-btn").addEventListener("click", () => openFilter(f.id));
  document.addEventListener("click", (e) => {
    // путь берётся из события, а не из e.target: щелчок по «Выбрать все» перерисовывает список,
    // и к этому моменту кнопка уже вне документа — список закрывался бы сам
    if (filterOpen() && !e.composedPath().some((n) => n.classList?.contains("ms"))) openFilter(null);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !filterOpen()) return;
    const f = FILTERS.find((x) => !$(x.id).querySelector(".ms-pop").hidden);
    openFilter(null);
    $(f.id).querySelector(".ms-btn").focus();
  });
  // Глагол попадает в колоду и в счётчик, только если подходят и уровень, и тип
  function inScope(v) {
    return !!v && inCourse(v) && P.settings.levels.includes(v.level) && P.settings.types.includes(Core.typeOf(v));
  }
  function renderFlow() {
    for (const b of $("flow").querySelectorAll("button")) {
      b.setAttribute("aria-checked", String(b.dataset.flow === P.settings.flow));
      b.onclick = () => {
        if (P.settings.flow === b.dataset.flow) return;
        P.settings.flow = b.dataset.flow;
        save();
        renderFlow();
        selectTab(P.settings.tab); // вернувшись к «По шагам» без «Знаю», вкладка времён закрывается — уходим на первую
        restartDeck();
      };
    }
  }
  // Подсказка «?»: наведение — для мыши, нажатие — для телефона (Safari не даёт кнопке фокус по касанию)
  const flowHelp = $("flow-help");
  flowHelp.querySelector(".qmark").addEventListener("click", (e) => {
    e.stopPropagation();
    const open = !flowHelp.classList.contains("open");
    flowHelp.classList.toggle("open", open);
    e.currentTarget.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", () => {
    flowHelp.classList.remove("open");
    flowHelp.querySelector(".qmark").setAttribute("aria-expanded", "false");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") flowHelp.classList.remove("open");
  });

  function renderDir() {
    for (const b of $("dir").querySelectorAll("button")) {
      b.setAttribute("aria-checked", String(b.dataset.dir === P.settings.dir));
      b.onclick = () => {
        if (P.settings.dir === b.dataset.dir) return;
        P.settings.dir = b.dataset.dir;
        save();
        renderDir();
        restartDeck();
      };
    }
  }

  /* ---------- колода и карточка ---------- */
  function eligible() {
    const s = sets();
    const known = s.known[P.settings.dir];
    return VERBS.filter((v) => inScope(v) && !s.skip.has(v.verb) && !known.has(v.verb)).map((v) => v.verb);
  }
  // Вкладки форм: карточка — одна форма глагола из «Знаю» этого направления, ещё не освоенная.
  // «все лица» берут шесть лиц, «· я» — только первое, какое есть (у безличного πρέπει это 3-е).
  // Лицо без русской формы карточкой не становится (у B1 их пока нет) — счётчик называет такие глаголы.
  function formsOf(v, tab) {
    const t = tab.tense;
    const ids = [];
    v[t].forEach((gr, p) => { if (gr && (v["ru_" + t] || [])[p]) ids.push(Core.formId(t, v.verb, p)); });
    const first = v[t].findIndex((f) => f);
    return tab.first ? ids.filter((id) => Core.parseFormId(id).person === first) : ids;
  }
  function knownInScope() {
    const known = new Set(P.known[P.settings.dir]);
    return VERBS.filter((v) => inScope(v) && known.has(v.verb));
  }
  // Глаголы вкладок времён — одна точка на колоду, счётчики и объяснение пустой колоды
  function formsPool() {
    if (!allAtOnce()) return knownInScope();
    const skip = new Set(P.skip);
    return VERBS.filter((v) => inScope(v) && !skip.has(v.verb));
  }
  const curTab = () => TABS.find((t) => t.id === P.settings.tab);
  // Усвоение выключено — в колоду идёт всё, включая освоенное: список «Освоено» тогда скрыт,
  // и спрятанное в нём иначе было бы не достать
  const isDone = (id, dir = P.settings.dir) => P.settings.mastery && Core.isMastered(P, dir, id);
  const masteredIds = (dir) => Object.keys(P.correct[dir]).filter((id) => Core.isMastered(P, dir, id));
  function eligibleFormsFor(tab) {
    return formsPool().flatMap((v) => formsOf(v, tab)).filter((id) => !isDone(id));
  }
  const eligibleForms = () => eligibleFormsFor(curTab());
  const decks = { verbs: new Core.Deck(eligible), forms: new Core.Deck(eligibleForms) };
  const deck = () => decks[formsMode() ? "forms" : "verbs"];
  let current = null; // на карточке: глагол (первая вкладка) или форма «present:γράφω:3»
  let flipped = false;
  let revealed = false; // ответ уже видели: кнопки под карточкой больше не прячутся до следующей карточки

  // Все фильтры кончаются этим вызовом — поэтому через него же перерисовывается и справочник
  function restartDeck() {
    if (curTab() && curTab().ref) return renderRef();
    deck().reset();
    next();
  }
  function next() {
    current = deck().next();
    flipped = false;
    revealed = false;
    $("example").hidden = true;
    renderCard();
    renderCounter();
  }

  // Что сейчас на карточке, в одном виде для обеих вкладок
  const GR_PRON = ["εγώ", "εσύ", "αυτός/αυτή", "εμείς", "εσείς", "αυτοί/αυτές"];
  function cardItem() {
    if (!formsMode()) {
      const v = byVerb.get(current);
      // у безличных (πρέπει) карточка спрашивает 3-е лицо — и пример берётся в нём же
      // курс пишет иначе (φιλώ при нашем φιλάω) — показываем оба написания, ключ прогресса остаётся прежним
      const gr = v.spelling ? `${v.verb} / ${v.spelling}` : v.verb;
      return { v, gr, ru: v.ru, person: Math.max(0, v.present.findIndex((f) => f)), tense: "present" };
    }
    const f = Core.parseFormId(current);
    const v = byVerb.get(f.verb);
    return { v, gr: v[f.tense][f.person], ru: v["ru_" + f.tense][f.person], person: f.person, tense: f.tense };
  }
  function exampleNow() {
    const it = cardItem();
    return (it.v.examples[it.tense] || []).find((e) => e.person === it.person) || null;
  }
  // одна и та же русская форма у разных глаголов (γυρίζω / επιστρέφω — «возвращаюсь»): при RU → GR верны все
  const byRuForm = new Map();
  for (const v of VERBS) {
    for (const t of Core.TENSES) {
      (v["ru_" + t] || []).forEach((ru, p) => {
        if (!ru || !v[t][p]) return;
        const k = `${t}|${p}|${ru}`;
        if (!byRuForm.has(k)) byRuForm.set(k, []);
        if (!byRuForm.get(k).includes(v[t][p])) byRuForm.get(k).push(v[t][p]); // γύρισα — и у γυρίζω, и у γυρνάω
      });
    }
  }

  function renderCard() {
    const has = current != null;
    $("stage").hidden = !has;
    $("empty").hidden = has;
    if (!has) {
      renderEmpty();
      return;
    }
    const it = cardItem();
    const v = it.v;
    const forms = formsMode();
    const grToRu = P.settings.dir === "gr-ru";
    const showGreek = grToRu || flipped; // при RU → GR греческое слово — это ответ
    const front = $("card-front");
    const alt = $("card-alt");
    const meta = $("card-meta");
    const card = $("card");
    card.classList.toggle("is-back", flipped);
    alt.textContent = "";
    meta.textContent = "";
    // в ответе греческая форма — с местоимением: «(εμείς) γράφουμε»; у безличных (πρέπει) местоимения нет
    const grAnswer = forms && v[it.tense][0] ? `(${GR_PRON[it.person]}) ${it.gr}` : it.gr;

    if (!flipped) {
      front.textContent = grToRu ? it.gr : it.ru;
      front.classList.toggle("is-ru", !grToRu);
      front.lang = grToRu ? "el" : "ru";
    } else if (grToRu) {
      front.textContent = it.ru;
      front.classList.add("is-ru");
      front.lang = "ru";
      alt.textContent = it.gr;
      alt.lang = "el";
    } else {
      const same = forms ? byRuForm.get(`${it.tense}|${it.person}|${it.ru}`) || [it.gr] : byRu.get(v.ru) || [v.verb];
      front.textContent = grAnswer;
      front.classList.remove("is-ru");
      front.lang = "el";
      const others = same.filter((x) => x !== it.gr);
      if (others.length) {
        alt.textContent = "тот же перевод: " + others.join(", ");
        alt.lang = "el";
      }
    }
    if (flipped) {
      const l = document.createElement("span");
      l.className = "lvl";
      l.textContent = v.level;
      // уровень — плашкой, спряжение — словом: одинаковые буквы не должны выглядеть одинаково
      const t = document.createElement("span");
      t.className = "conj";
      t.textContent = "спряжение " + Core.typeOf(v);
      meta.append(l, t);
      if (forms) {
        // от какого глагола форма и, если усвоение учитывается, сколько у этой формы «Верно» из нужных
        const g = document.createElement("span");
        g.className = "conj";
        const w = document.createElement("span");
        w.lang = "el";
        w.textContent = v.verb;
        g.append(w);
        if (P.settings.mastery) g.append(` · усвоено ${P.correct[P.settings.dir][current] || 0} из ${P.settings.masteryGoal}`);
        meta.append(g);
      }
    }
    card.setAttribute("aria-label", flipped ? "Перевод. Нажмите, чтобы вернуть" : "Карточка. Нажмите, чтобы перевернуть");
    $("card-hint").textContent = flipped ? "" : "нажмите или пробел — перевернуть";
    $("card-speak").hidden = !(greekVoice && showGreek);
    $("actions").hidden = !(revealed && !forms);
    $("actions-forms").hidden = !(revealed && forms);
    $("skip-form").hidden = !allAtOnce();
    $("actions-forms").classList.toggle("two", !allAtOnce());
    $("pass-btn").hidden = revealed; // пропустить можно, только не заглянув в ответ
    $("example-btn").hidden = !(revealed && exampleNow());
  }

  // Почему карточек нет — у каждой вкладки свои причины, и человек должен понять, что делать
  function renderEmpty() {
    const dir = P.settings.dir === "gr-ru" ? "GR → RU" : "RU → GR";
    let title, text;
    if (!formsMode()) {
      title = "В выбранных уровнях карточек не осталось";
      text = "Всё разложено по спискам «Знаю» и «Не учим». Добавьте уровень или спряжение либо верните слова в обучение.";
    } else if (!formsPool().length && allAtOnce()) {
      title = "В выбранных фильтрах нет глаголов";
      text = "Добавьте уровень или спряжение, переключитесь на «Все» или верните слова из списка «Не учим».";
    } else if (!formsPool().length) {
      title = `Нет слов из «Знаю ${dir}» в выбранных фильтрах`;
      text = "В режиме «По шагам» здесь тренируются только слова, отмеченные «Знаю» во вкладке «Настоящее · я» в этом же направлении. Отметьте слова там, добавьте уровень и спряжение или включите «Всё сразу».";
    } else if (!formsPool().some((v) => formsOf(v, curTab()).length)) {
      title = "Для этих слов ещё нет русских форм";
      text = "Формы по лицам пока составлены для уровней A1 и A2. Добавьте эти уровни в фильтр.";
    } else {
      title = "Все формы освоены";
      text = `Освоенные формы — в списке «Освоено ${dir}». Оттуда их можно вернуть в обучение.`;
    }
    $("empty-title").textContent = title;
    $("empty-text").textContent = text;
  }

  function flip() {
    if (current == null) return;
    flipped = !flipped;
    if (flipped) revealed = true;
    const card = $("card");
    card.classList.remove("flip");
    void card.offsetWidth; // перезапуск анимации
    card.classList.add("flip");
    renderCard();
  }

  function renderCounter() {
    renderTabCounts(); // счётчик под вкладкой меняется тогда же, что и строка над карточкой
    const c = $("counter");
    c.textContent = "";
    const part = (label, n) => {
      const b = document.createElement("b");
      b.textContent = n;
      c.append(label + " ", b);
    };
    if (formsMode()) {
      const verbs = formsPool();
      const all = verbs.flatMap((v) => formsOf(v, curTab()));
      if (P.settings.mastery) {
        part("Освоено", all.filter((id) => isDone(id)).length);
        c.append(" · ");
        part("Осталось", eligibleForms().length);
        c.append(` из ${all.length}`);
      } else {
        // без учёта колода бесконечна: «осталось» было бы неправдой
        part("Карточек в колоде", all.length);
        c.append(" · усвоение не учитывается");
      }
      // глаголы из «Знаю», для которых нет русских форм, в колоду не попали — говорим об этом
      const noRu = verbs.filter((v) => !formsOf(v, curTab()).length).length;
      if (noRu) c.append(` · без русских форм: ${noRu}`);
      return;
    }
    const inLv = (list) => list.filter((x) => inScope(byVerb.get(x))).length;
    const total = VERBS.filter(inScope).length;
    const known = inLv(P.known[P.settings.dir]);
    const skip = inLv(P.skip);
    const left = eligible().length;
    part("Выучено", known);
    c.append(" · ");
    part("Не учим", skip);
    c.append(" · ");
    part("Осталось", left);
    c.append(` из ${total}`);
  }

  $("card").addEventListener("click", flip);
  $("card").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); flip(); }
  });
  $("card-speak").addEventListener("click", (e) => {
    e.stopPropagation(); // озвучка не переворачивает карточку
    if (current) speak(cardItem().gr);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== " " && e.code !== "Space") return;
    if ($("settings").open || $("help").open) return;
    if (filterOpen() || e.target.closest?.(".ms")) return; // пробел ставит галочку или открывает список
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if ($("panel-present1").hidden) return;
    e.preventDefault();
    flip();
  });

  $("actions").addEventListener("click", (e) => {
    const act = e.target.closest("button")?.dataset.act;
    if (!act || current == null) return;
    const dir = P.settings.dir;
    if (act === "know" && !P.known[dir].includes(current)) P.known[dir].push(current);
    if (act === "skip" && !P.skip.includes(current)) P.skip.push(current); // «Не учим» — сразу для обоих направлений
    save();
    if (act !== "learn") renderTabs(); // «Знаю» может открыть следующие вкладки
    next();
  });

  // «Верно» — +1 к усвоению формы (если оно учитывается), набрала порог — освоена и больше не выпадает;
  // «Повторить» — ничего не добавляет, форма вернётся в следующем круге
  $("actions-forms").addEventListener("click", (e) => {
    const act = e.target.closest("button")?.dataset.act;
    if (!act || current == null) return;
    if (act === "master" && P.settings.mastery) {
      const c = P.correct[P.settings.dir];
      c[current] = (c[current] || 0) + 1;
      save();
      showProgress(current, c[current]);
    }
    // «Не учим» с карточки формы — про весь глагол: список глагольный и общий для направлений. Плашка называет
    // глагол, иначе исчезновение всех его форм выглядело бы потерей
    if (act === "skip") {
      const verb = Core.parseFormId(current).verb;
      if (!P.skip.includes(verb)) P.skip.push(verb);
      save();
      showToast(verb, " — в «Не учим»", false);
      renderTabs();
    }
    next();
  });

  // Плашка над следующей карточкой: прежняя уже ушла, а увидеть свой счёт хочется сразу
  let toastTimer = null;
  function showProgress(id, n) {
    const f = Core.parseFormId(id);
    const goal = P.settings.masteryGoal;
    showToast(byVerb.get(f.verb)[f.tense][f.person], n >= goal ? " — освоено" : ` · ${n} из ${goal}`, n >= goal);
  }
  function showToast(greek, rest, done) {
    const t = $("toast");
    t.textContent = "";
    const w = document.createElement("span");
    w.lang = "el";
    w.textContent = greek;
    t.append(w, rest);
    t.classList.toggle("done", done);
    t.hidden = false;
    $("counter").style.visibility = "hidden"; // плашка на время заменяет строку счётчика, а не наползает на неё
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.hidden = true;
      $("counter").style.visibility = "";
    }, 1800);
  }

  // без отметок: из этого круга карточка уже вынута, а в следующей перетасовке будет снова
  $("pass-btn").addEventListener("click", () => {
    if (current != null) next();
  });

  $("example-btn").addEventListener("click", () => {
    const ex = exampleNow();
    if (!ex) return;
    const box = $("example");
    if (!box.hidden) { box.hidden = true; return; }
    $("example-el").textContent = ex.el;
    $("example-el").lang = "el";
    $("example-ru").textContent = ex.ru;
    $("example-speak").hidden = !greekVoice;
    box.hidden = false;
  });
  $("example-speak").addEventListener("click", () => {
    const ex = exampleNow();
    if (ex) speak(ex.el);
  });

  /* ---------- окно списков ---------- */
  // вкладка списка и направление — две отдельные оси: пять кнопок в ряд переносились на вторую строку
  let listKind = "known";
  let listDir = "gr-ru";
  const keyOf = (kind) => (kind === "skip" ? "skip" : `${kind}:${listDir}`);
  // «Освоено» не хранится, а считается из счёта «Верно» — поэтому убрать оттуда значит обнулить счёт
  function listOf(key) {
    if (key === "skip") return P.skip;
    const [kind, dir] = key.split(":");
    return kind === "mastered" ? masteredIds(dir) : P.known[dir];
  }
  function removeFromList(key, id) {
    if (key.startsWith("mastered:")) delete P.correct[key.split(":")[1]][id];
    else listOf(key).splice(listOf(key).indexOf(id), 1);
  }
  function clearList(key) {
    if (key.startsWith("mastered:")) for (const id of listOf(key)) removeFromList(key, id);
    else listOf(key).length = 0;
  }
  const TENSE_TITLES = { present: "Настоящее время", past: "Аорист", future: "Будущее простое" };
  const RU_PRON = ["я", "ты", "он/она", "мы", "вы", "они"];
  // поиск без учёта регистра и ударений: «ξερω» находит «ξέρω»
  const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  function renderList() {
    // без учёта усвоения списка «Освоено» нет: в колоду и так идёт всё
    if (!P.settings.mastery && listKind === "mastered") listKind = "known";
    $("list-tabs").querySelector('[data-list="mastered"]').hidden = !P.settings.mastery;
    const listKey = keyOf(listKind);
    for (const b of $("list-tabs").querySelectorAll("button")) {
      b.setAttribute("aria-selected", String(b.dataset.list === listKind));
      b.querySelector(".badge").textContent = listOf(keyOf(b.dataset.list)).length; // число — для выбранного направления
    }
    // у «Не учим» направления нет, но место переключателя остаётся — иначе окно меняло бы высоту
    $("list-dir").style.visibility = listKind === "skip" ? "hidden" : "";
    for (const b of $("list-dir").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.dir === listDir));
    const q = fold($("list-search").value.trim());
    // строка списка в одном виде для глаголов и для форм: id — то, что лежит в списке
    const forms = listKey.startsWith("mastered:");
    const items = listOf(listKey)
      .map((id) => {
        if (!forms) {
          const v = byVerb.get(id);
          return v && { id, v, gr: v.verb, ru: v.ru, tense: "", person: 0, note: v.level + " · спр. " + Core.typeOf(v) };
        }
        const f = Core.parseFormId(id);
        const v = f && byVerb.get(f.verb);
        const gr = v && v[f.tense][f.person];
        if (!gr) return null;
        const ru = (v["ru_" + f.tense] || [])[f.person] || "";
        return { id, v, gr, ru, tense: f.tense, person: f.person, note: `${v.verb} · ${RU_PRON[f.person]}` };
      })
      .filter(Boolean)
      .filter((x) => !q || [x.gr, x.ru, x.v.verb].some((s) => fold(s).includes(q)))
      .sort((a, b) => Core.TENSES.indexOf(a.tense) - Core.TENSES.indexOf(b.tense)
        || a.v.verb.localeCompare(b.v.verb, "el") || a.person - b.person);
    const ul = $("list");
    ul.textContent = "";
    let section = null;
    for (const x of items) {
      // «Освоено» общее для всех вкладок «все лица» — разделено по временам
      if (forms && x.tense !== section) {
        section = x.tense;
        const sep = document.createElement("li");
        sep.className = "sep";
        sep.textContent = TENSE_TITLES[x.tense];
        ul.append(sep);
      }
      const li = document.createElement("li");
      const w = document.createElement("span");
      w.className = "w";
      w.lang = "el";
      w.textContent = x.gr;
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = x.ru;
      const l = document.createElement("span");
      l.className = "lvl";
      l.textContent = x.note;
      const back = document.createElement("button");
      back.type = "button";
      back.className = "btn-link";
      back.textContent = "Вернуть в обучение";
      back.addEventListener("click", () => {
        removeFromList(listKey, x.id);
        save();
        renderList();
        afterListsChanged();
      });
      li.append(w, t, l, back);
      ul.append(li);
    }
    const empty = $("list-empty");
    const total = listOf(listKey).length;
    empty.hidden = items.length > 0;
    ul.hidden = items.length === 0;
    empty.textContent = total ? "Ничего не найдено." : "Список пуст.";
    $("list-clear").hidden = total === 0;
    $("list-clear-confirm").hidden = true;
  }
  function afterListsChanged() {
    // очищенное «Знаю» запирает вкладку «все лица» — тогда возвращаемся на первую
    const tab = TABS.find((t) => t.id === P.settings.tab);
    if (isLocked(tab)) selectTab(TABS[0].id);
    renderTabs();
    renderCounter();
    if (current == null) next(); // экран «карточек не осталось» мог стать неправдой
  }

  $("list-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    listKind = b.dataset.list;
    renderList();
  });
  $("list-dir").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    listDir = b.dataset.dir;
    renderList();
  });
  $("list-search").addEventListener("input", renderList);
  $("list-clear").addEventListener("click", () => {
    $("list-clear").hidden = true;
    $("list-clear-confirm").hidden = false;
  });
  $("list-clear-no").addEventListener("click", renderList);
  $("list-clear-yes").addEventListener("click", () => {
    clearList(keyOf(listKind));
    save();
    renderList();
    afterListsChanged();
  });

  function openSettings() {
    $("settings-status").textContent = "";
    $("settings-status").className = "status";
    $("import-confirm").hidden = true;
    $("list-search").value = "";
    listDir = P.settings.dir; // открываем в том направлении, в котором сейчас тренируются
    renderMastery();
    renderList();
    $("settings").showModal();
  }
  $("settings-btn").addEventListener("click", openSettings);
  $("empty-open").addEventListener("click", () => {
    // из «все лица» — сразу в «Освоено» этого направления: за ним человек и пришёл
    if (formsMode() && P.settings.mastery) listKind = "mastered";
    openSettings();
  });
  $("settings-close").addEventListener("click", () => $("settings").close());
  $("settings").addEventListener("click", (e) => { if (e.target === $("settings")) $("settings").close(); });

  // Меню тренажёров под названием: открывается нажатием, закрывается щелчком мимо и Esc
  function setApps(open) {
    $("apps-menu").hidden = !open;
    $("apps-btn").setAttribute("aria-expanded", String(open));
  }
  $("apps-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    setApps($("apps-menu").hidden);
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("#apps-menu")) setApps(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setApps(false); });

  // Насколько свежий набор курса: дата берётся из course.js, который пишут сборка и робот курса.
  // Нет файла (старая выкладка) — строки нет, а не «дата неизвестна»
  const course = window.COURSE;
  if (course && /^\d{4}-\d{2}-\d{2}$/.test(course.updated || "")) {
    const [y, m, d] = course.updated.split("-");
    $("course-note").textContent = `Набор «Ελληνικά Τώρα 1+1» — по сайту курса от ${d}.${m}.${y}, глаголов: ${course.verbs}.`;
    $("course-note").hidden = false;
  }
  $("help-btn").addEventListener("click", () => $("help").showModal());
  $("help-close").addEventListener("click", () => $("help").close());
  $("help").addEventListener("click", (e) => { if (e.target === $("help")) $("help").close(); });

  /* ---------- усвоение ---------- */
  function renderMastery() {
    const on = P.settings.mastery;
    $("mastery-on").checked = on;
    $("mastery-goal").value = P.settings.masteryGoal;
    $("mastery-goal").disabled = !on;
    $("mastery-goal-row").classList.toggle("off", !on);
    $("mastery-note").textContent = on
      ? "Во всех вкладках, кроме «Настоящее · я»: каждое «Верно» добавляет форме единицу усвоения, «Повторить» — нет. Освоенная форма уходит в список «Освоено» и больше не выпадает."
      : "Выключено: карточки идут по кругу без счёта, включая освоенные, «Верно» ничего не добавляет, список «Освоено» скрыт. Набранный счёт сохраняется и вернётся при включении.";
  }
  // переключатель и порог меняют состав колоды и списков — перестраиваем всё, что от них зависит
  function afterMasteryChanged() {
    save();
    renderMastery();
    renderList();
    if (formsMode()) restartDeck();
    else renderCounter();
  }
  $("mastery-on").addEventListener("change", (e) => {
    P.settings.mastery = e.target.checked; // счёт «Верно» не трогаем: выключение его не сбрасывает
    afterMasteryChanged();
  });
  $("mastery-goal").addEventListener("change", (e) => {
    const n = Math.round(Number(e.target.value));
    P.settings.masteryGoal = Number.isFinite(n) ? Math.min(Core.GOAL_MAX, Math.max(Core.GOAL_MIN, n)) : Core.GOAL_DEFAULT;
    afterMasteryChanged();
  });

  /* ---------- перенос прогресса ---------- */
  function status(text, ok) {
    const s = $("settings-status");
    s.textContent = text;
    s.className = "status " + (ok ? "ok" : "err");
  }
  $("export-btn").addEventListener("click", () => {
    const blob = new Blob([Core.toExport(P)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `greek-verbs-progress-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    status("Файл сохранён в папку загрузок.", true);
  });

  let pendingImport = null;
  $("import-btn").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const { progress, report } = Core.fromImport(await file.text(), allVerbs);
      pendingImport = progress;
      const extra = report.unknown ? ` Неизвестных этой версии словаря слов пропущено: ${report.unknown}.` : "";
      $("import-summary").textContent =
        `В файле: «Знаю GR → RU» — ${progress.known["gr-ru"].length}, «Знаю RU → GR» — ${progress.known["ru-gr"].length}, ` +
        `«Не учим» — ${progress.skip.length}; форм с усвоением — ${Object.keys(progress.correct["gr-ru"]).length} (GR → RU) ` +
        `и ${Object.keys(progress.correct["ru-gr"]).length} (RU → GR).` +
        `${extra} Заменить текущий прогресс этим файлом?`;
      $("import-confirm").hidden = false;
      $("settings-status").textContent = "";
    } catch (err) {
      pendingImport = null;
      $("import-confirm").hidden = true;
      status(err.message, false);
    }
  });
  $("import-no").addEventListener("click", () => {
    pendingImport = null;
    $("import-confirm").hidden = true;
  });
  $("import-yes").addEventListener("click", () => {
    if (!pendingImport) return;
    P = pendingImport;
    pendingImport = null;
    save();
    $("import-confirm").hidden = true;
    applyTheme();
    renderLevels();
    renderDir();
    renderFlow();
    renderMastery();
    renderList();
    renderTabs();
    restartDeck();
    status("Прогресс загружен.", true);
  });

  /* ---------- справочник ---------- */
  // Список — глаголы под теми же фильтрами, что и карточки (курс, уровень, спряжение). «Не учим» справочник
  // не прячет: это словарь, а не колода. Поиск — по самому глаголу, написанию курса, любой форме и переводу:
  // встретил «έγραψα» — найдёшь γράφω
  const refKey = new Map();
  for (const v of VERBS) {
    const forms = Core.TENSES.flatMap((t) => v[t] || []).flatMap(Core.formVariants); // «γράφουνε» найдёт γράφω
    refKey.set(v.verb, Core.fold([v.verb, v.spelling, ...forms, v.ru].filter(Boolean).join(" ")));
  }
  let refVerb = null;  // открытый глагол; null — список
  $("ref-btn").addEventListener("click", () => selectTab(curTab().ref ? lastTab : "ref"));

  // Какие фильтры действуют — словами, из тех же настроек, что отбирают глаголы: иначе из списка не понять,
  // почему в нём 77, а не 722
  function refScopeText() {
    const s = P.settings;
    const lv = s.levels.length === Core.LEVELS.length ? "все уровни" : s.levels.join(", ");
    const tp = s.types.length === Core.TYPES.length ? "все спряжения"
      : s.types.length <= 3 ? `спряжение ${s.types.join(", ")}` : `${s.types.length} из ${Core.TYPES.length} спряжений`;
    return `Показаны глаголы под фильтрами: ${s.textbook ? "Ελληνικά Τώρα 1+1" : "весь словарь"} · ${lv} · ${tp}`;
  }
  let refScroll = 0;   // где был список: «назад» возвращает туда же, а не в начало алфавита
  const refName = (v) => (v.spelling ? `${v.verb} / ${v.spelling}` : v.verb);
  const el = (tag, cls, text, lang) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    if (lang) n.lang = lang;
    return n;
  };

  function renderRef() {
    hideRefTip();
    const v = refVerb && byVerb.get(refVerb);
    $("ref-list-view").hidden = !!v;
    $("ref-verb").hidden = !v;
    if (v) renderRefVerb(v);
    else renderRefList();
  }

  function renderRefList() {
    const q = Core.fold($("ref-search").value.trim());
    const all = VERBS.filter(inScope).sort((a, b) => Core.fold(a.verb).localeCompare(Core.fold(b.verb), "el"));
    const shown = q ? all.filter((v) => refKey.get(v.verb).includes(q)) : all;
    $("ref-scope").textContent = refScopeText();
    $("ref-count").textContent = q ? `Найдено: ${shown.length} из ${all.length}` : `Глаголов: ${all.length}`;
    const ul = $("ref-list");
    ul.textContent = "";
    const letters = new Set();
    for (const v of shown) {
      const L = Core.letterOf(v.verb);
      if (!letters.has(L)) {
        const sep = el("li", "sep", L);
        sep.id = "ref-L-" + L;
        ul.append(sep);
        letters.add(L);
      }
      const b = el("button", "ref-row");
      b.type = "button";
      b.append(el("span", "w", refName(v), "el"), el("span", "t", v.ru || ""), el("span", "lvl", v.level));
      b.addEventListener("click", () => openRefVerb(v.verb));
      const li = el("li");
      li.append(b);
      ul.append(li);
    }
    if (!shown.length) {
      ul.append(el("li", "ref-empty", all.length
        ? "Ничего не нашлось. Поиск идёт по глаголу, любой его форме и переводу."
        : "Под выбранными фильтрами глаголов нет. Добавьте уровень или спряжение либо переключитесь на «Все»."));
    }
    // буквы без глаголов не прячутся, а гаснут: алфавит остаётся на месте и читается как алфавит
    const abc = $("ref-abc");
    abc.textContent = "";
    for (const L of Core.GREEK_ABC) {
      const b = el("button", null, L);
      b.type = "button";
      b.disabled = !letters.has(L);
      b.setAttribute("aria-label", `Буква ${L}`);
      b.addEventListener("click", () => document.getElementById("ref-L-" + L)?.scrollIntoView({ block: "start" }));
      abc.append(b);
    }
  }

  function renderRefVerb(v) {
    $("ref-title").textContent = refName(v);
    $("ref-ru").textContent = v.ru || "";
    $("ref-meta").textContent = [v.level, `спряжение ${Core.typeOf(v)}`,
      v.textbook ? `Ελληνικά Τώρα${v.textbook === true ? "" : `, урок ${v.textbook}`}` : null].filter(Boolean).join(" · ");
    $("ref-speak").hidden = !greekVoice;
    const box = $("ref-tables");
    box.textContent = "";
    for (const t of Core.TENSES) {
      if (!(v[t] || []).some(Boolean)) continue;
      const sec = el("section", "ref-tense");
      sec.append(el("h3", null, TENSE_TITLES[t]));
      const table = el("table");
      for (let p = 0; p < 6; p++) {
        const form = v[t][p];
        if (!form) continue; // у безличных (πρέπει) только 3-е лицо — пустые строки читались бы как пропуск
        const tr = el("tr");
        tr.append(el("td", "pron", GR_PRON[p], "el"));
        const td = el("td", "form");
        const ex = (v.examples[t] || []).find((e) => e.person === p);
        if (ex) {
          const b = el("button", "ref-form", form, "el");
          b.type = "button";
          b.setAttribute("aria-label", `${form} — показать пример`);
          b.addEventListener("click", (e) => { e.stopPropagation(); showRefTip(b, ex); });
          td.append(b);
        } else {
          td.append(el("span", null, form, "el"));
        }
        // перевод дважды: колонкой на широком экране и строкой под формой на телефоне — колонке там не хватало
        // места, и длинная форма («θα καταλάβουμε») наезжала на перевод
        const ru = (v["ru_" + t] || [])[p] || "";
        if (ru) td.append(el("span", "ru-inline", ru));
        tr.append(td, el("td", "ru", ru));
        table.append(tr);
      }
      sec.append(table);
      box.append(sec);
    }
  }

  function openRefVerb(verb) {
    refScroll = window.scrollY;
    refVerb = verb;
    // на телефоне «назад» — жест или кнопка системы: без своей записи в истории он уводил бы со страницы
    history.pushState({ ref: verb }, "");
    renderRef();
    $("panel-ref").scrollIntoView({ block: "start" });
  }
  function closeRefVerb() {
    refVerb = null;
    renderRef();
    window.scrollTo(0, refScroll);
  }
  $("ref-back").addEventListener("click", () => {
    if (history.state && history.state.ref) history.back(); // закроет popstate — одна дорога для кнопки и жеста
    else closeRefVerb();
  });
  // «назад» / «вперёд» показывают то, что записано в истории: глагол или список
  window.addEventListener("popstate", (e) => {
    const want = e.state && e.state.ref;
    if (want && byVerb.has(want)) {
      refVerb = want;
      renderRef();
    } else if (refVerb) {
      closeRefVerb();
    }
  });
  // после перезагрузки справочник открывается списком — запись «открыт глагол» от прошлого раза уже неправда
  if (history.state && history.state.ref) history.replaceState(null, "");
  $("ref-search").addEventListener("input", renderRefList);
  $("ref-speak").addEventListener("click", () => refVerb && speak(refVerb));

  // Подсказка с примером: по нажатию (на телефоне наведения нет), под формой и в пределах панели
  let refTipEx = null;
  function showRefTip(anchor, ex) {
    const tip = $("ref-tip");
    refTipEx = ex;
    $("ref-tip-el").textContent = ex.el;
    $("ref-tip-ru").textContent = ex.ru;
    $("ref-tip-speak").hidden = !greekVoice;
    tip.hidden = false;
    const panel = $("panel-ref").getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    tip.style.top = `${a.bottom - panel.top + 6}px`;
    tip.style.left = `${Math.max(0, Math.min(a.left - panel.left, panel.width - tip.offsetWidth))}px`;
  }
  function hideRefTip() {
    $("ref-tip").hidden = true;
    refTipEx = null;
  }
  $("ref-tip-speak").addEventListener("click", (e) => {
    e.stopPropagation();
    if (refTipEx) speak(refTipEx.el);
  });
  document.addEventListener("click", (e) => {
    if (!$("ref-tip").hidden && !e.target.closest("#ref-tip")) hideRefTip();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideRefTip(); });

  /* ---------- старт ---------- */
  if (!VERBS.length) {
    document.querySelector("main").textContent = "Не удалось загрузить словарь (verbs.js).";
    return;
  }
  applyTheme();
  renderLevels();
  renderDir();
  renderFlow();
  save(); // заодно проверяем, работает ли хранилище
  selectTab(P.settings.tab);
  started = true;
  next();
})();
