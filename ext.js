// ============ РАСШИРЕНИЕ: видит страницу + автопилот ============
const AP_MAX_STEPS = 50;          // шагов автопилота до остановки
const AP_MAX_ACTIONS = 10;        // действий за один ответ модели
const AP_MAX_ITEMS = 400;         // сколько элементов показывать модели
const AP_MAX_CLICKS = 1000;       // максимум кликов в одной команде [CLICK: id | N]
const AP_MAX_TRACE = 6;           // сколько последних шагов текущего цикла держать в контексте
let apStep = 0, apStop = false;
let apConsecutiveFailures = 0;
let apPrev = null;                // прошлый снимок (для диффа)
let apFailed = [];                // что уже не сработало — модели нельзя повторять
let apScreenshot = null;
let apReadText = "";
let apTrace = [];                 // эфемерные шаги текущего цикла автопилота (только в RAM)
let targetCount = 0;              // целевое число циклов/картинок из запроса пользователя (0 — без автолимита)
let completedCount = 0;           // счётчик реально выполненных циклов/скачиваний
let apTaskMsg = null;             // закреплённое исходное сообщение пользователя с текущей задачей
let apTaskText = "";              // текст исходной задачи пользователя
let apExpectsDownload = false;    // задача явно упоминает скачивание
const sleep = ms => new Promise(r => setTimeout(r, ms));
if(settings.seePage === undefined) settings.seePage = true;

function resetAutopilot(){
  apStep = 0;
  apStop = false;
  apConsecutiveFailures = 0;
  apPrev = null;
  apFailed = [];
  apScreenshot = null;
  apReadText = "";
  apTrace = [];
  targetCount = 0;
  completedCount = 0;
  apTaskMsg = null;
  apTaskText = "";
  apExpectsDownload = false;
}

function parseRuCountToken(tok){
  const t = String(tok || "").trim().toLowerCase().replace(/ё/g, "е");
  if(/^\d+$/.test(t)) return parseInt(t, 10);
  const words = {
    "один":1, "одна":1, "одну":1, "одного":1,
    "два":2, "две":2, "двух":2,
    "три":3, "трех":3,
    "четыре":4, "четырех":4,
    "пять":5, "пяти":5,
    "шесть":6, "шести":6,
    "семь":7, "семи":7,
    "восемь":8, "восьми":8,
    "девять":9, "девяти":9,
    "десять":10, "десяти":10
  };
  return words[t] || 0;
}

function extractTargetCount(text){
  const src = String(text || "").trim();
  if(!src) return 0;
  const norm = src.toLowerCase().replace(/ё/g, "е");
  // Убираем разрешения/размеры/время/координаты/проценты, чтобы не путать их с количеством циклов
  const cleaned = norm
    .replace(/\b\d+\s*[xх×*]\s*\d+\b/g, " ")
    .replace(/\b\d+\s*:\s*\d+\b/g, " ")
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:сек(?:унд[уы]?)?|мин(?:ут[уы]?)?|час(?:а|ов)?|мс|ms|s|px|%|k|к)\b/g, " ");
  const NUM = "(\\d+|один|одна|одну|одного|два|две|двух|три|трех|четыре|четырех|пять|пяти|шесть|шести|семь|семи|восемь|восьми|девять|девяти|десять|десяти)";
  const okNum = n => (n >= 1 && n <= 500) ? n : 0;

  // 1) Явные слова «цикл / итерация / повтор / круг / серия»
  const mCycle = cleaned.match(new RegExp(`(?:^|[^\\p{L}\\d])${NUM}\\s*(?:цикл(?:а|ов)?|итерац(?:ия|ии|ий)|повтор(?:а|ов|ения|ений)?|круг(?:а|ов)?|подход(?:а|ов)?|сери(?:я|и|й)|cycles?|iterations?|loops?)(?=$|[^\\p{L}\\d])`, "u"));
  if(mCycle){ const n = okNum(parseRuCountToken(mCycle[1])); if(n) return n; }

  // 2) «повтори N раз» / «сделай (всё/это) N раз» (но не «кликни N раз»)
  const mRep = cleaned.match(new RegExp(`(?:повтор(?:и|ить|яй|ите)|прогон(?:и|ить)|запуст(?:и|ить)|(?:сделай|выполни)(?:\\s+(?:все|это|так))?)\\s+(?:(?:это|все|действие|цикл|еще)\\s+){0,2}${NUM}\\s*раз(?:а)?(?=$|[^\\p{L}\\d])`, "u"));
  if(mRep){ const n = okNum(parseRuCountToken(mRep[1])); if(n) return n; }

  // 3) Генерация/скачивание N картинок/изображений/фото/файлов/генераций/штук
  const UNITS = "(?:картин(?:ку|ки|ок|очки|очек)|изображен(?:ие|ия|ий)|фото(?:графи(?:ю|и|й))?|арт(?:а|ов)?|рисун(?:ок|ка|ков)|генерац(?:ию|ии|й)|вариант(?:а|ов)?|файл(?:а|ов)?|видео|ролик(?:а|ов)?|штук(?:у|и)?|шт\\.?|images?|pics?|pictures?|photos?|files?|videos?|items?)";
  const mGenItem = cleaned.match(new RegExp(`(?:сгенерир|генерир|созда|сдела|скача|сохран|загруз|получ|выгруз|нарису|generate|create|download|save)[^.\\n]{0,50}?(?:^|[^\\p{L}\\d])${NUM}\\s*${UNITS}(?=$|[^\\p{L}\\d])`, "u"));
  if(mGenItem){ const n = okNum(parseRuCountToken(mGenItem[1])); if(n) return n; }

  const hasWorkflowVerb = /(?:сгенерир|генерир|созда|скача|сохран|выгруз|нарису|повтор|цикл|generate|download|save)/u.test(cleaned);
  if(hasWorkflowVerb){
    const mItem = cleaned.match(new RegExp(`(?:^|[^\\p{L}\\d])${NUM}\\s*${UNITS}(?=$|[^\\p{L}\\d])`, "u"));
    if(mItem){ const n = okNum(parseRuCountToken(mItem[1])); if(n) return n; }
    // «N раза сгенерируй и скачай» (исключаем кликеры «кликни/нажми N раз»)
    const mTimes = cleaned.match(new RegExp(`(?:^|[^\\p{L}\\d])${NUM}\\s*раз(?:а)?(?=$|[^\\p{L}\\d])`, "u"));
    if(mTimes){
      const before = cleaned.slice(Math.max(0, mTimes.index - 24), mTimes.index);
      if(!/(?:клик|нажм|жми|тап|click|tap)/u.test(before)){
        const n = okNum(parseRuCountToken(mTimes[1]));
        if(n) return n;
      }
    }
  }
  return 0;
}

function isDownloadTextMatch(text, allowGenericSave = false){
  const s = String(text || "");
  if(!s) return false;
  if(/(?:upload|загрузи(?:ть)?\s*(?:с\s*комп|с\s*устройств|файл|изображен|фото)|настройк|профил|settings|profile)/i.test(s)) return false;
  if(/(?:скача|download|save[\s_-]*(?:image|img|file|photo|pic|png|jpg|jpeg|webp|video|as)|сохрани(?:ть)?[\s_-]+(?:картинк|изображен|фото|файл|видео|как))/i.test(s)) return true;
  if(allowGenericSave && /(?:^|[^\p{L}])(?:сохрани(?:ть)?|save)(?=$|[^\p{L}])/iu.test(s)) return true;
  return false;
}

const AP_PROMPT = `Ты AI-ассистент в боковой панели браузера и видишь открытую вкладку (блок [СТРАНИЦА] в сообщении пользователя).
Если пользователь спрашивает о странице — отвечай по её содержимому.
АВТОПИЛОТ: если пользователь просит что-то СДЕЛАТЬ на странице (задач может быть НЕСКОЛЬКО) — выполняй их по порядку, шаг за шагом.
Для действий используй только отдельные команды формата [TYPE: ...], [CLICK: ...] и т.п. Не помещай команды в примеры, цитаты или блоки кода. Если команда не сработала, выбери другой способ.

Элементы страницы пронумерованы с префиксом фрейма (например, 0:12). Формат строки:
НОМЕР | тип | подпись | значение | координаты | состояние
Например: 0:12 | input:text | Email | пусто | 640,240 | обязательное
Номера НЕ МЕНЯЮТСЯ между шагами — указывай номер точно как в списке (вместе с префиксом, например 0:12).

Действия — до ${AP_MAX_ACTIONS} за ответ, выполняются строго в том порядке, в каком написаны:
[TYPE: 0:5 | текст] — ввести текст в поле №0:5
[CLICK: 0:12] — клик по элементу №0:12
[CLICK: 0:12 | 50] или [CLICK: 0:12 | 50 | 100] — кликнуть по элементу №0:12 много раз подряд (50 раз, пауза 100 мс; по умолчанию 150 мс, до ${AP_MAX_CLICKS} кликов)
[ENTER: 0:5] — Enter в поле №0:5
[SELECT: 0:7 | Москва] — выбрать вариант в выпадающем списке №0:7
[OPEN: https://...] — открыть адрес в текущей вкладке
[SCROLL: down] или [SCROLL: up] — прокрутить страницу
[WAIT: 2] — подождать 2 секунды, если сайт явно грузит
[KEY: Tab] или [KEY: Ctrl+A] — отправить клавишу активному элементу
[BACK] — вернуться на предыдущую страницу
[HOVER: 0:12] — навести указатель на элемент №0:12
[READ] — прочитать дополнительный текст страницы
[SHOT] — сделать скриншот для следующего шага (требуется модель с vision)

Правила:
1. Сначала действия, потом короткий текст. Пример: «Заполняю форму» [TYPE: 0:3 | Иван] [TYPE: 0:4 | ivan@mail.ru] [CLICK: 0:9]
2. Если пользователь просит покликать по элементу много раз (как кликер) — используй [CLICK: id | количество | пауза_мс], а не повторяй одиночный [CLICK].
3. Поле уже заполнено нужным — не переписывай.
4. Элемента нет в списке → [SCROLL: down], затем смотри обновлённый список элементов.
5. Не повторяй действие, которое завершилось ошибкой (блок [УЖЕ НЕ СРАБОТАЛО]). Если действие должно было открыть/переключить элемент, но ничего не изменилось — попробуй другой элемент или способ.
6. [DONE] — только когда ВСЕ задачи выполнены, с кратким итогом.
7. Совсем невозможно → [ERROR: причина].
8. Снимок [SHOT] появится в следующем сообщении пользователя; используй его вместе со списком элементов.
9. Если указан блок [СТАТУС ЦИКЛА] (Выполнено X из Y) — выполняй по одному циклу за раз; в конце каждого завершённого цикла добавляй [CYCLE_DONE] и не начинай лишние циклы сверх Y.
На обычные вопросы отвечай без действий.`;

async function getTargetTab(){
  const ok = t => t && /^(https?|file):/.test(t.url||"");
  // 1) боковая панель: активная вкладка этого же окна
  let [tab] = await chrome.tabs.query({active:true, currentWindow:true});
  if(ok(tab)) return tab;
  // 2) отдельное окно: активная вкладка последнего обычного окна браузера
  try{
    const w = await chrome.windows.getLastFocused({windowTypes:["normal"]});
    const [t2] = await chrome.tabs.query({active:true, windowId:w.id});
    if(t2) return t2;
  }catch{}
  const all = await chrome.tabs.query({active:true, windowType:"normal"});
  return all.find(ok) || all[0] || tab;
}

// --- снимок страницы: тип, подпись, значение, координаты, состояние, визуальный порядок ---
async function pageSnapshot(){
  try{
    const tab = await getTargetTab();
    if(!tab || !/^(https?|file):/.test(tab.url||"")) return {blocked:true, url:tab?.url||"", title:tab?.title||""};
    const results = await chrome.scripting.executeScript({target:{tabId:tab.id, allFrames:true}, func:(MAX)=>{
      // номера живут в странице и не меняются между шагами (WeakMap + счётчик)
      const WM = window.__aiIds || (window.__aiIds = new WeakMap());
      let seq = window.__aiSeq || 0;
      const vis = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return r.width>0 && r.height>0 && s.visibility!=="hidden" && s.display!=="none" && s.opacity!=="0"; };
      const clean = s => (s||"").trim().replace(/\s+/g," ").slice(0,120);
      const q = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,label,[contenteditable="true"],[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="option"],[role="textbox"],[role="combobox"],[role="switch"],[tabindex],[onclick],div,span';
      const items = [];
      let elementCount = 0;
      const seen = new Set();
      const roots = [document];
      for(let i=0;i<roots.length && elementCount<MAX;i++){
        const root = roots[i];
        for(const host of root.querySelectorAll("*")) if(host.shadowRoot && !roots.includes(host.shadowRoot)) roots.push(host.shadowRoot);
        for(const el of root.querySelectorAll(q)){
          if(elementCount >= MAX) break;
          if(seen.has(el)) continue;
          seen.add(el);
          if(!vis(el)) continue;
          if(el.shadowRoot && !roots.includes(el.shadowRoot)) roots.push(el.shadowRoot);
          const tag = el.tagName.toLowerCase();
          const style = getComputedStyle(el);
          const isNative = /^(a|button|input|select|textarea|summary|label)$/.test(tag);
          const hasInteractiveAttr = el.hasAttribute("role") || el.hasAttribute("tabindex") || el.hasAttribute("onclick");
          if(!isNative && !hasInteractiveAttr){
            if(style.cursor !== "pointer") continue;
            const parentStyle = el.parentElement ? getComputedStyle(el.parentElement) : null;
            if(parentStyle && parentStyle.cursor === "pointer") continue;
          }
        const role = el.getAttribute("role");
        const kind = tag==="input" ? `input:${el.type||"text"}` : (role ? `${tag}[${role}]` : tag);
        const isField = /input|textarea|select/.test(tag) || el.isContentEditable || el.getAttribute("role")==="textbox";
        const label = clean(el.innerText || el.getAttribute("aria-label") || el.getAttribute("title")
          || el.getAttribute("placeholder") || el.getAttribute("alt") || el.querySelector?.("img")?.alt
          || el.name || el.id || el.getAttribute("data-testid") || el.getAttribute("href") || "");
        if(!label && !isField) continue;
        let id = WM.get(el);
        if(!id){ id = ++seq; WM.set(el, id); window.__aiSeq = seq; }
        if(el.getAttribute("data-ai-id") !== String(id)) el.setAttribute("data-ai-id", String(id));
        const r = el.getBoundingClientRect();
        const x = Math.round(r.left + r.width/2), y = Math.round(r.top + r.height/2);
        const st = [];
        if(el.disabled || el.getAttribute("aria-disabled")==="true") st.push("недоступен");
        if(el.required) st.push("обязательное");
        if(el.type==="checkbox" || el.type==="radio" || role==="checkbox" || role==="switch")
          st.push((el.checked ?? el.getAttribute("aria-checked")==="true") ? "отмечено" : "не отмечено");
        const exp = el.getAttribute("aria-expanded");
        if(exp) st.push(exp==="true" ? "раскрыто" : "свёрнуто");
        let val = "";
        if(isField && !el.isContentEditable && el.type!=="checkbox" && el.type!=="radio") val = clean(el.value);
        else if(el.isContentEditable) val = clean(el.innerText);
        const off = (y < 0 || y > innerHeight) ? "вне экрана" : "";
        items.push({ id, y, x, sig:`${kind}|${label}|${val}|${st.join(",")}`,
          line:`${id} | ${kind} | ${label || "(поле)"} | ${val ? "«"+val+"»" : "пусто"} | ${x},${y}`
              + (st.length ? " | " + st.join(",") : "") + (off ? " | " + off : "") });
        elementCount++;
      }
      }
      // визуальный порядок: сверху вниз, затем слева направо
      items.sort((a,b)=> (Math.round(a.y/24)-Math.round(b.y/24)) || (a.x-b.x));
      window.__aiSeq = seq;
      const text = document.body.innerText.replace(/\n{3,}/g,"\n\n");
      return { url: location.href, title: document.title, textLen: text.length,
               frameText: text.slice(0,8000), text: text.slice(0,8000), h: innerHeight,
               total: items.length,
               items: items.slice(0,MAX).map(i=>({id:i.id, line:i.line, sig:i.sig})) };
    }, args:[AP_MAX_ITEMS]});
    const frames = results.filter(r=>r.result && !r.error).map(({frameId, result})=>({frameId, result}));
    if(!frames.length) return null;
    const main = frames.find(f=>f.frameId===0)?.result || frames[0].result;
    const items = frames.flatMap(f=>f.result.items.map(i=>({
      id:`${f.frameId}:${i.id}`, frameId:f.frameId, localId:i.id,
      line:i.line.replace(/^\d+\s*\|/, `${f.frameId}:${i.id} |`), sig:i.sig
    }))).slice(0, AP_MAX_ITEMS);
    const fullText = frames.map(f=>f.result.frameText || f.result.text).filter(Boolean).join("\n\n");
    let textHash = 0;
    for(let i = 0; i < fullText.length; i++) textHash = (textHash * 31 + fullText.charCodeAt(i)) | 0;
    return {...main, items, total:frames.reduce((n,f)=>n+f.result.total,0),
      text:fullText, textHash,
      textLen:frames.reduce((n,f)=>n+f.result.textLen,0)};
  }catch(e){ return {blocked:true, error:e.message}; }
}

// быстрая подпись страницы — чтобы ловить конец загрузки/анимации
async function pageSig(){
  try{
    const tab = await getTargetTab();
    if(!tab) return null;
    const [r] = await chrome.scripting.executeScript({target:{tabId:tab.id}, func:()=>{
      const t = (document.body ? document.body.innerText : "").slice(0, 30000);
      let h = 0; for(let i=0;i<t.length;i++) h = (h*31 + t.charCodeAt(i))|0;
      return {h, n:t.length, d:document.querySelectorAll("[data-ai-id]").length,
              ready:document.readyState==="complete", busy:!!document.querySelector('[aria-busy="true"]')};
    }});
    return r?.result || null;
  }catch{ return null; }
}

// ждём, пока страница изменится и успокоится (SPA, модалки, ajax) — вместо фиксированных пауз
async function waitStable(base){
  const t0 = Date.now();
  await sleep(250);
  let last = null, quiet = 0, noMove = 0;
  while(Date.now() - t0 < 6000){
    if(apStop) return false;
    const s = await pageSig();
    if(!s){ await sleep(250); continue; }
    const moved = !base || s.h!==base.h || s.n!==base.n || s.d!==base.d;
    if(moved){
      noMove = 0;
      if(last && last.h===s.h && last.n===s.n && last.d===s.d) quiet++; else quiet = 0;
      last = s;
      if(quiet >= 2 && !s.busy){ await sleep(200); return true; }
    } else {
      noMove++;
      if(noMove >= 4 && s.ready && !s.busy) return false;
    }
    await sleep(250);
  }
  // не дождались изменений — хотя бы убеждаемся, что вкладка догрузилась
  try{ const tab = await getTargetTab();
    for(let i=0;i<20 && !apStop;i++){ const t = await chrome.tabs.get(tab.id); if(t.status==="complete") break; await sleep(200); } }catch{}
  return false;
}

async function actOnPage(kind, target, value){
  const tab = await getTargetTab();
  if(kind === "open"){ await chrome.tabs.update(tab.id, {url:target}); return {ok:true, msg:target}; }
  if(kind === "wait"){ const s = Math.min(15, Math.max(0.5, parseFloat(value)||2)); await sleep(s*1000); return {ok:true, msg:`пауза ${s} c`}; }
  if(kind === "back"){
    await chrome.scripting.executeScript({target:{tabId:tab.id}, func:()=>history.back()});
    return {ok:true, msg:"назад"};
  }
  if(kind === "shot"){
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {format:"jpeg", quality:70});
    apScreenshot = await compressImage(dataUrl);
    return {ok:true, msg:"снимок экрана готов для следующего запроса"};
  }
  if(kind === "read"){
    const [readResult] = await chrome.scripting.executeScript({target:{tabId:tab.id}, func:()=>document.body?.innerText.slice(0,16000)||""});
    apReadText = readResult?.result || "";
    return {ok:true, msg:`прочитан текст (${apReadText.length} символов)`};
  }
  const targetText = String(target||"").trim().replace(/^[`'"#№]+|[`'"]+$/g, "");
  const framed = targetText.match(/^(\d+):(\d+)$/);
  const frameId = framed ? Number(framed[1]) : 0;
  const localTarget = framed ? framed[2] : targetText;
  const [res] = await chrome.scripting.executeScript({target:{tabId:tab.id, frameIds:[frameId]}, args:[kind, localTarget, value ?? ""], func:(kind, t, v)=>{
    if(kind === "scroll"){ window.scrollBy({top:(t==="up"?-1:1)*innerHeight*0.8, behavior:"instant"}); return {ok:true, msg:t}; }
    if(kind === "read") return {ok:true, msg:document.body.innerText.slice(0,16000)};
    if(kind === "key"){
      const el = document.activeElement || document.body;
      const key = t, actualKey = key.replace(/^(ctrl|shift|alt)\+/i, "");
      const codes = {Tab:"Tab",Enter:"Enter",Escape:"Escape",Backspace:"Backspace",Delete:"Delete",ArrowUp:"ArrowUp",ArrowDown:"ArrowDown",ArrowLeft:"ArrowLeft",ArrowRight:"ArrowRight",Home:"Home",End:"End",PageUp:"PageUp",PageDown:"PageDown",Space:"Space"};
      const init = {key:actualKey==="Space"?" ":actualKey, code:codes[actualKey]||(/^[a-z]$/i.test(actualKey)?`Key${actualKey.toUpperCase()}`:actualKey), bubbles:true, cancelable:true, ctrlKey:/^ctrl\+/i.test(key), shiftKey:/^shift\+/i.test(key), altKey:/^alt\+/i.test(key)};
      if(actualKey==="Tab"){ const els=[...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(e=>!e.disabled && e.getClientRects().length); const i=els.indexOf(el); els[i+(init.shiftKey?-1:1)]?.focus(); }
      else for(const type of ["keydown","keypress","keyup"]) el.dispatchEvent(new KeyboardEvent(type, init));
      return {ok:true, msg:`клавиша ${t}`};
    }
    if(kind === "hover"){
      const selector = t.replace(/^[`'"#№]+|[`'"]+$/g, "");
      const roots = [document];
      for(let i=0;i<roots.length;i++) for(const host of roots[i].querySelectorAll("*")) if(host.shadowRoot) roots.push(host.shadowRoot);
      let el = /^\d+$/.test(selector) ? roots.map(root=>root.querySelector(`[data-ai-id="${selector}"]`)).find(Boolean) : null;
      if(!el){ try{ for(const root of roots){ el = root.querySelector(selector); if(el) break; } }catch{} }
      if(!el) return {ok:false, msg:"элемент не найден"};
      el.scrollIntoView({block:"center"});
      const r = el.getBoundingClientRect();
      const base = {bubbles:true, cancelable:true, view:window, clientX:r.left+r.width/2, clientY:r.top+r.height/2};
      const ptr = {...base, pointerId:1, pointerType:"mouse", isPrimary:true};
      el.dispatchEvent(new PointerEvent("pointerover", ptr));
      el.dispatchEvent(new MouseEvent("mouseover", base));
      let cur = el;
      for(let d=0; cur && d<5; d++, cur=cur.parentElement){
        cur.dispatchEvent(new PointerEvent("pointerenter", {...ptr, bubbles:false}));
        cur.dispatchEvent(new MouseEvent("mouseenter", {...base, bubbles:false}));
      }
      el.dispatchEvent(new PointerEvent("pointermove", ptr));
      el.dispatchEvent(new MouseEvent("mousemove", base));
      const hName = (el.innerText||el.getAttribute("aria-label")||el.tagName).replace(/\s+/g," ").trim().slice(0,50);
      return {ok:true, msg:`наведено: ${hName}`};
    }
    const s = t.replace(/^[`'"#№]+|[`'"]+$/g,"");
    const roots = [document];
    for(let i=0;i<roots.length;i++) for(const host of roots[i].querySelectorAll("*")) if(host.shadowRoot) roots.push(host.shadowRoot);
    let el = /^\d+$/.test(s) ? roots.map(root=>root.querySelector(`[data-ai-id="${s}"]`)).find(Boolean) : null;
    if(!el){ try{ for(const root of roots){ el = root.querySelector(s); if(el) break; } }catch{} }
    if(!el){ const low = s.toLowerCase(); el = roots.flatMap(root=>[...root.querySelectorAll("a,button,[role=button],input,label,summary,div,span")])
      .find(e => (e.innerText||e.value||e.getAttribute("aria-label")||"").trim().toLowerCase() === low); }
    if(!el && kind === "click" && v && typeof v === "object" && Number.isFinite(v.cx) && Number.isFinite(v.cy)){
      const hit = document.elementFromPoint(v.cx, v.cy);
      if(hit){
        el = hit.closest?.('button,a,[role="button"],[onclick],[tabindex],label,input') || hit;
        if(/^\d+$/.test(s) && el) el.setAttribute("data-ai-id", s);
      }
    }
    if(!el) return {ok:false, msg:"элемент не найден (возможно, страница перерисовалась — обнови снимок через [SCROLL])"};
    el.scrollIntoView({block:"center"});
    const name = (el.innerText||el.value||el.getAttribute("aria-label")||el.placeholder||el.tagName).replace(/\s+/g," ").trim().slice(0,50);
    if(kind === "select"){
      const want = (v||"").trim().toLowerCase();
      const opts = [...(el.options||[])];
      const opt = opts.find(o=>(o.text||"").trim().toLowerCase()===want) || opts.find(o=>(o.text||"").toLowerCase().includes(want));
      if(!opt) return {ok:false, msg:`вариант «${v}» не найден; есть: ${opts.slice(0,8).map(o=>(o.text||"").trim()).join(", ")}`};
      el.focus(); el.value = opt.value;
      el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true}));
      return {ok:true, msg:`${name}: «${(opt.text||"").trim()}»`};
    }
    if(kind === "type"){
      el.focus();
      if(el.isContentEditable){ document.execCommand("selectAll"); document.execCommand("insertText", false, v); }
      else {
        const proto = el.tagName==="TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName==="SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const set = Object.getOwnPropertyDescriptor(proto, "value")?.set; set ? set.call(el, v) : (el.value = v);
      }
      el.dispatchEvent(new Event("input", {bubbles:true})); el.dispatchEvent(new Event("change", {bubbles:true}));
      return {ok:true, msg:`${name}: «${String(v).slice(0,40)}»`};
    }
    if(kind === "enter"){
      el.focus();
      const o = {key:"Enter", code:"Enter", keyCode:13, which:13, bubbles:true, cancelable:true};
      el.dispatchEvent(new KeyboardEvent("keydown", o)); el.dispatchEvent(new KeyboardEvent("keypress", o)); el.dispatchEvent(new KeyboardEvent("keyup", o));
      if(el.form && !el.isContentEditable){ el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit(); }
      return {ok:true, msg:name};
    }
    // click: полная цепочка событий — React/Vue/Radix часто слушают pointerdown/mousedown
    if(el.disabled || el.getAttribute("aria-disabled") === "true"){
      return {ok:false, msg:`элемент «${name}» недоступен (disabled)`};
    }
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width/2, cy = r.top + r.height/2;
    const dlAnchor = el.closest?.("a[download], a[href]");
    const dlHref = dlAnchor?.getAttribute("href") || "";
    const isDropdownToggle = !!(el.getAttribute("aria-haspopup") || el.hasAttribute("aria-expanded"));
    const dlMeta = [
      el.innerText, el.value, el.getAttribute("aria-label"), el.getAttribute("title"),
      el.getAttribute("data-testid"), el.getAttribute("data-tooltip"), el.id,
      typeof el.className === "string" ? el.className : "",
      dlAnchor?.getAttribute("aria-label"), dlAnchor?.getAttribute("title"),
      el.querySelector?.("svg title")?.textContent, el.querySelector?.("img")?.alt
    ].filter(Boolean).join(" ");
    const hasDlAttr = el.hasAttribute("download") || !!el.closest?.("[download]");
    const hasDlHref = /^(blob:|data:)/i.test(dlHref) || /[/?&=](?:download|export)\b/i.test(dlHref);
    const isExcludedDl = /(?:upload|загрузи(?:ть)?\s*(?:с\s*комп|с\s*устройств|файл|изображен|фото)|настройк|профил|settings|profile)/i.test(dlMeta);
    const hasDlText = !isExcludedDl && /(?:скача|download|save[\s_-]*(?:image|img|file|photo|pic|png|jpg|jpeg|webp|video|as)|сохрани(?:ть)?[\s_-]+(?:картинк|изображен|фото|файл|видео|как))/i.test(dlMeta);
    const isDownload = !isDropdownToggle && (hasDlAttr || hasDlHref || hasDlText);
    const isSave = !isDropdownToggle && !isExcludedDl && /(?:^|[^\p{L}])(?:сохрани(?:ть)?|save)(?=$|[^\p{L}])/iu.test(dlMeta);
    const base = {bubbles:true, cancelable:true, view:window, clientX:cx, clientY:cy, button:0};
    const ptrDown = {...base, pointerId:1, pointerType:"mouse", isPrimary:true, buttons:1};
    const ptrUp   = {...base, pointerId:1, pointerType:"mouse", isPrimary:true, buttons:0};
    if(el.style){
      const OM = window.__aiOutlines || (window.__aiOutlines = new WeakMap());
      let st = OM.get(el);
      if(!st){ st = {old: el.style.outline, timer: 0}; OM.set(el, st); }
      clearTimeout(st.timer);
      el.style.outline = "3px solid #ff5d73";
      st.timer = setTimeout(()=>{ el.style.outline = st.old; OM.delete(el); }, 900);
    }
    el.dispatchEvent(new PointerEvent("pointerover", ptrUp));
    el.dispatchEvent(new MouseEvent("mouseover", base));
    el.dispatchEvent(new PointerEvent("pointerdown", ptrDown));
    el.dispatchEvent(new MouseEvent("mousedown", {...base, buttons:1}));
    el.focus?.();
    el.dispatchEvent(new PointerEvent("pointerup", ptrUp));
    el.dispatchEvent(new MouseEvent("mouseup", {...base, buttons:0}));
    if(typeof el.click === "function") el.click();
    else el.dispatchEvent(new MouseEvent("click", base));
    return {ok:true, msg:name, cx, cy, isDownload, isSave};
  }});
  return res?.result || {ok:false, msg:"нет результата"};
}

async function clickMany(target, count, delayMs){
  if(count <= 1) return actOnPage("click", target, "");
  if(count >= 10) toast(`🖱 Кликаю ×${count} (⏹ — остановить)`);
  let done = 0, lastName = target, lastPos = null;
  for(let i = 0; i < count; i++){
    if(apStop) break;
    const r = await actOnPage("click", target, lastPos || "");
    if(!r.ok){
      if(done === 0) return r;
      return {ok:true, msg:`${lastName} ×${done}/${count} (остановлено: ${r.msg})`};
    }
    done++;
    if(r.msg) lastName = r.msg;
    if(Number.isFinite(r.cx) && Number.isFinite(r.cy)) lastPos = {cx: r.cx, cy: r.cy};
    if(i + 1 < count && !apStop) await sleep(delayMs);
  }
  if(apStop) return {ok:done > 0, msg:`${lastName} ×${done}/${count} (остановлено)`};
  return {ok:true, msg:`${lastName} ×${done}`};
}

// --- текст [СТРАНИЦА] для модели: всегда актуальный список элементов + дифф изменений ---
function buildCtx(snap, mode, msgs){
  if(!snap) return "\n\n[СТРАНИЦА]\n(не удалось прочитать страницу)";
  if(snap.blocked) return `\n\n[СТРАНИЦА]\n${snap.title||""}\n${snap.url||""}\n(браузер не разрешает расширениям читать эту страницу${snap.error?": "+snap.error:""})`;
  const head = `\n\n[СТРАНИЦА]\n${snap.title}\n${snap.url}`;
  const fail = apFailed.length ? `\n\n[УЖЕ НЕ СРАБОТАЛО — НЕ ПОВТОРЯЙ]\n${apFailed.join("\n")}` : "";
  const items = snap.items.map(i=>i.line).join("\n");
  const itemsBlock = `\n\nЭлементы (${snap.items.length} из ${snap.total}, порядок сверху вниз, вне экрана помечено):\n` + (items || "(нет)");
  if(mode !== "diff" || !apPrev || apPrev.url !== snap.url){
    return `${head}${fail}${itemsBlock}\n\nТекст страницы (начало):\n${snap.text.slice(0,8000)}`;
  }
  const prev = new Map(apPrev.items.map(i=>[i.id, i.sig]));
  const cur = new Map(snap.items.map(i=>[i.id, i.sig]));
  const added = snap.items.filter(i=>!prev.has(i.id)).map(i=>i.line);
  const changed = snap.items.filter(i=>prev.has(i.id) && prev.get(i.id)!==i.sig).map(i=>i.line);
  const gone = [...prev.keys()].filter(id=>!cur.has(id)).map(id=>"№"+id);
  const textChanged = snap.textHash !== apPrev.textHash || snap.textLen !== apPrev.textLen;
  let s = `${head}${fail}\n\n[ЧТО ИЗМЕНИЛОСЬ С ПРОШЛОГО ШАГА]`;
  if(!added.length && !changed.length && !gone.length && !textChanged){
    s += "\nDOM и текст не изменились (если действие должно было изменить страницу — проверь другой элемент или способ).";
  } else {
    if(added.length) s += "\nПоявились:\n" + added.join("\n");
    if(changed.length) s += "\nИзменились:\n" + changed.join("\n");
    if(gone.length) s += "\nИсчезли: " + gone.join(", ");
    if(textChanged) s += "\n\nТекст сейчас (начало):\n" + snap.text.slice(0,2000);
  }
  s += itemsBlock;
  return s;
}

// --- хуки в основной код чата ---
window.HOOKS = {
  onReset(reason){
    if((reason === "newChat" || reason === "selectChat") && controller){
      apStop = true;
      return;
    }
    resetAutopilot();
  },

  async transformMessages(msgs, c){
    if(!settings.seePage) return msgs;
    const snap = await pageSnapshot();
    const rawApCtx = settings.apContext;
    const apLimit = (rawApCtx === undefined || rawApCtx === null || rawApCtx === "")
      ? 20
      : Math.max(0, parseInt(rawApCtx, 10) || 0);

    // 1) Чистая история диалога без текущего пустого placeholder-ассистента и без старых auto-сообщений
    const rawHistory = (c?.messages || []).slice(0, -1).filter(m => !m.auto && (!m.error || m.content));
    let lastUserIdx = -1;
    for(let i = rawHistory.length - 1; i >= 0; i--){
      if(rawHistory[i].role === "user"){ lastUserIdx = i; break; }
    }

    // При старте новой задачи закрепляем исходное сообщение пользователя и извлекаем targetCount
    if(apStep === 0 && lastUserIdx >= 0){
      apTaskMsg = rawHistory[lastUserIdx];
      apTaskText = (apTaskMsg.content || "").trim();
      targetCount = extractTargetCount(apTaskText);
      completedCount = 0;
      apExpectsDownload = /(?:скача|download)/i.test(apTaskText);
    }

    let apiMsgs = [];
    if(apStep > 0 && (apTaskMsg || lastUserIdx >= 0)){
      // Активный цикл автопилота: окно прошлых сообщений ДО текущей задачи + ЗАКРЕПЛЁННАЯ текущая задача + эфемерные шаги apTrace
      const taskIdx = apTaskMsg ? rawHistory.lastIndexOf(apTaskMsg) : lastUserIdx;
      const anchorIdx = taskIdx >= 0 ? taskIdx : lastUserIdx;
      const pinnedMsg = apTaskMsg || rawHistory[anchorIdx];
      let priorSlice = anchorIdx > 0 ? rawHistory.slice(0, anchorIdx) : [];
      if(apLimit === 1){
        priorSlice = [];
      } else if(apLimit > 1){
        priorSlice = priorSlice.slice(-(apLimit - 1));
      }
      while(priorSlice.length && priorSlice[0].role === "assistant") priorSlice = priorSlice.slice(1);
      const priorApi = buildApiMessages({messages: priorSlice}, {
        limit: 0, includeSystem: false, includeMedia: false, cleanAutopilot: true
      });
      const currentUserApi = userMsgToApi(pinnedMsg, {includeMedia: true});
      apiMsgs = normalizeApiMessages([...priorApi, currentUserApi]);

      const recentTrace = apTrace.slice(-AP_MAX_TRACE);
      if(apTrace.length > AP_MAX_TRACE){
        const skipped = apTrace.length - AP_MAX_TRACE;
        const skippedNote = targetCount > 0
          ? `Выполнил первые ${skipped} шагов задачи (сейчас выполнено ${completedCount} из ${targetCount}).`
          : `Выполнил первые ${skipped} шагов задачи.`;
        apiMsgs = normalizeApiMessages([
          ...apiMsgs,
          {role:"assistant", content:skippedNote},
          {role:"user", content:"Продолжай со следующего шага."}
        ]);
      }
      for(const step of recentTrace){
        apiMsgs.push({role:"assistant", content:step.assistant});
        apiMsgs.push({role:"user", content:step.result});
      }
    } else {
      // Новый запрос пользователя (или regen): ограниченное окно очищенной истории (исходная текущая задача в конце не обрезается)
      let sliced = apLimit > 0 ? rawHistory.slice(-apLimit) : rawHistory;
      while(sliced.length > 1 && sliced[0].role === "assistant") sliced = sliced.slice(1);
      apiMsgs = buildApiMessages({messages: sliced}, {
        limit: 0, includeSystem: false, mediaOnlyLastUser: true, cleanAutopilot: true
      });
      if(!apiMsgs.length || apiMsgs[apiMsgs.length - 1].role !== "user"){
        apiMsgs.push({role:"user", content:"Продолжи выполнение задачи."});
      }
    }

    // 2) Всегда актуальный системный промпт в начале
    const userSys = (settings.system || "").trim();
    apiMsgs.unshift({role:"system", content: userSys ? (AP_PROMPT + "\n\n" + userSys) : AP_PROMPT});

    // 3) Свежий DOM / список элементов + закреплённый статус цикла — ТОЛЬКО в текущий API-запрос
    let statusBlock = "";
    if(apStep > 0 && apTaskText){
      statusBlock += `\n\n[ИСХОДНАЯ ЗАДАЧА]\n${apTaskText.slice(0, 1000)}`;
    }
    if(targetCount > 0){
      const remaining = Math.max(0, targetCount - completedCount);
      statusBlock += `\n\n[СТАТУС ЦИКЛА]\nВыполнено ${completedCount} из ${targetCount} (осталось: ${remaining}).`
        + `\nВыполняй по одному циклу за раз; по завершении каждого цикла добавляй [CYCLE_DONE]. Не начинай новый цикл, если уже выполнено ${targetCount} из ${targetCount}.`;
    }
    const ctx = buildCtx(snap, apStep > 0 ? "diff" : "full", apiMsgs)
      + statusBlock
      + "\n\n[ФОРМАТ] Для действий на странице используй только команды [CLICK: id], [TYPE: id | текст], [SCROLL: down], [DONE] и т.д. Не пиши лог с эмодзи вместо команд.";
    apPrev = snap && !snap.blocked ? snap : null;

    for(let i = apiMsgs.length - 1; i >= 0; i--){
      if(apiMsgs[i].role !== "user") continue;
      if(typeof apiMsgs[i].content === "string") apiMsgs[i].content += ctx;
      else { const t = apiMsgs[i].content.find(p => p.type === "text"); t ? t.text += ctx : apiMsgs[i].content.unshift({type:"text", text:ctx}); }
      if(apReadText){
        const readContext = `\n\n[ДОПОЛНИТЕЛЬНЫЙ ТЕКСТ СТРАНИЦЫ]\n${apReadText}`;
        if(typeof apiMsgs[i].content === "string") apiMsgs[i].content += readContext;
        else {
          const t = apiMsgs[i].content.find(p=>p.type==="text");
          if(t) t.text += readContext; else apiMsgs[i].content.unshift({type:"text",text:readContext});
        }
        apReadText = "";
      }
      if(apScreenshot){
        const image = {type:"image_url", image_url:{url:apScreenshot}};
        if(typeof apiMsgs[i].content === "string") apiMsgs[i].content = [{type:"text", text:apiMsgs[i].content}, image];
        else apiMsgs[i].content.push(image);
        apScreenshot = null;
      }
      break;
    }
    return apiMsgs;
  },

  async afterGenerate(c, msg, aborted){
    if(aborted || msg.error || !settings.seePage){ resetAutopilot(); return; }
    let text = msg.content || "";
    const rawModelText = splitThink(text).rest.trim();
    const log = [];
    const traceLines = [];
    const okLabels = [];
    const prevItemsMap = new Map((apPrev?.items || []).map(i => [i.id, i.line]));
    let acted = false, failed = false;
    let stepDownloads = 0;
    let reachedTarget = false;

    // одно сканирование в порядке появления — действия выполняются как написаны
    const noCodeBlocks = text.replace(/```[\s\S]*?```/g, "");
    const executableText = noCodeBlocks.replace(/`[^`]*`/g, "");
    const RE = /\[(TYPE|CLICK|ENTER|SELECT|OPEN|SCROLL|WAIT|KEY|HOVER|READ|BACK|SHOT)(?::\s*([^\]\n]*))?\]/gi;
    let matches = [...executableText.matchAll(RE)];
    // если модель обернула команду в одинарные бэктики (например `[SCROLL: up]` или `⏳ [SCROLL: up]`), всё равно выполняем
    if(!matches.length) matches = [...noCodeBlocks.matchAll(RE)];
    const rawActs = matches.map(m=>({kind:m[1].toLowerCase(), arg:(m[2]||"").trim(), raw:m[0]}));
    const stripRaw = raw => {
      const escRaw = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const reWrapped = new RegExp("`[^`\\n]{0,6}" + escRaw + "\\s*`");
      if(reWrapped.test(text)) text = text.replace(reWrapped, "");
      else text = text.replace(raw, "");
    };
    const acts = [];
    for(const ra of rawActs){
      if(ra.kind === "click"){
        const p = (ra.arg||"").split("|").map(s=>s.trim());
        const target = p[0] || "";
        const count = Math.min(AP_MAX_CLICKS, Math.max(1, parseInt(p[1], 10) || 1));
        const delayMs = p[2] !== undefined && p[2] !== "" ? Math.min(5000, Math.max(10, parseInt(p[2], 10) || 150)) : 150;
        const prev = acts[acts.length - 1];
        if(prev && prev.kind === "click" && prev.target === target){
          prev.count = Math.min(AP_MAX_CLICKS, prev.count + count);
          prev.delayMs = Math.min(prev.delayMs, delayMs);
          prev.raws.push(ra.raw);
          continue;
        }
        acts.push({kind:"click", target, count, delayMs, value:"", raws:[ra.raw]});
      } else if(ra.kind === "type" || ra.kind === "select"){
        const p = (ra.arg||"").split("|");
        acts.push({kind:ra.kind, target:(p[0]||"").trim(), value:p.slice(1).join("|").trim(), raws:[ra.raw]});
      } else {
        acts.push({kind:ra.kind, target:ra.arg, value:"", raws:[ra.raw]});
      }
    }
    if(acts.some(a=>a.kind==="open" || a.kind==="back")) apPrev = null;
    const before = acts.length ? await pageSig() : null;

    let used = 0;
    apStop = false;
    if(acts.length){
      controller = new AbortController(); controller.signal.onabort = () => apStop = true; updateSendBtn();
    }
    try{
      for(const a of acts){
        if(apStop) break;
        if(used >= AP_MAX_ACTIONS){
          log.push(`⏸ ещё ${acts.length-used} действий — в следующем шаге`);
          traceLines.push(`Оставшиеся ${acts.length-used} действий перенесены на следующий шаг.`);
          for(let j = used; j < acts.length; j++) for(const raw of acts[j].raws) stripRaw(raw);
          break;
        }
        const icon = {type:"⌨️", click:"🖱", enter:"↵", select:"▾", open:"🌐", scroll:"↕️", wait:"⏳", key:"⌨️", hover:"↗️", read:"📖", back:"↩️", shot:"📸"}[a.kind] || "•";
        const hasTargetId = /^(click|type|enter|select|hover)$/.test(a.kind) && a.target;
        const cmdLabel = a.raws[0] || `[${a.kind.toUpperCase()}${a.target ? ": " + a.target : ""}]`;
        let hitTargetNow = false;
        try{
          const r = a.kind === "click"
            ? await clickMany(a.target, a.count, a.delayMs)
            : await actOnPage(a.kind, a.target, a.value);
          const cleanMsg = String(r.msg || "").replace(/\s+/g, " ").trim();
          if(r.ok){
            log.push(hasTargetId ? `${icon} [${a.target}] ${cleanMsg}` : `${icon} ${cleanMsg}`);
            traceLines.push(`${cmdLabel} -> OK${cleanMsg ? ": " + cleanMsg : ""}`);
            if(cleanMsg) okLabels.push(cleanMsg);
            acted = true;
            // Засчитываем завершённый цикл при успешном клике по скачиванию
            if(targetCount > 0 && a.kind === "click" && a.count === 1){
              const prevLine = prevItemsMap.get(a.target) || "";
              const allowSave = !apExpectsDownload;
              const isCycleDownload = !!(
                r.isDownload ||
                (allowSave && r.isSave) ||
                isDownloadTextMatch(cleanMsg, allowSave) ||
                isDownloadTextMatch(prevLine, allowSave)
              );
              if(isCycleDownload){
                stepDownloads++;
                completedCount++;
                log.push(`📊 Выполнено ${completedCount} из ${targetCount}`);
                traceLines.push(`Выполнено ${completedCount} из ${targetCount}.`);
                if(completedCount >= targetCount){
                  reachedTarget = true;
                  hitTargetNow = true;
                }
              }
            }
          } else {
            log.push(`⚠️ ${a.kind} ${a.target}: ${cleanMsg}`); failed = true;
            traceLines.push(`${cmdLabel} -> ОШИБКА: ${cleanMsg}`);
            const failKey = `${a.kind} ${a.target}`.trim();
            if(apFailed.length < 6 && !apFailed.some(x => x.startsWith(failKey + " —"))) apFailed.push(`${failKey} — ${cleanMsg}`);
          }
        }catch(e){
          const errText = String(e.message||e).replace(/\s+/g," ");
          log.push(`⚠️ ${a.kind}: ${errText}`); failed = true;
          traceLines.push(`${cmdLabel} -> ОШИБКА: ${errText}`);
        }
        for(const raw of a.raws) stripRaw(raw);
        used++;
        if(hitTargetNow){
          // Жёсткая остановка: отменяем все оставшиеся действия в этом ответе, чтобы не начать лишний цикл
          for(let j = used; j < acts.length; j++) for(const raw of acts[j].raws) stripRaw(raw);
          break;
        }
        if(!apStop && a.kind !== "wait" && a.kind !== "scroll") await sleep(200);
      }
    } finally {
      if(controller){ controller = null; updateSendBtn(); }
    }

    const remainderNoBlocks = text.replace(/```[\s\S]*?```/g, "");
    const executableRemainder = remainderNoBlocks.replace(/`[^`]*`/g, "");
    const terminalErrorMatch = executableRemainder.match(/\[ERROR:\s*([^\]]+)\]/i) || remainderNoBlocks.match(/\[ERROR:\s*([^\]]+)\]/i);
    const terminalError = !!terminalErrorMatch;
    const hasCycleDone = /\[CYCLE_DONE\]/i.test(executableRemainder) || /\[CYCLE_DONE\]/i.test(remainderNoBlocks);
    const hasDone = /\[DONE\]/i.test(executableRemainder) || /\[DONE\]/i.test(remainderNoBlocks);

    // Если в этом шаге не было авто-детекта скачивания, но модель отметила завершение цикла тегом [CYCLE_DONE]
    if(targetCount > 0 && !reachedTarget && stepDownloads === 0 && hasCycleDone && !failed && !apStop){
      completedCount++;
      log.push(`📊 Выполнено ${completedCount} из ${targetCount}`);
      traceLines.push(`Выполнено ${completedCount} из ${targetCount}.`);
      if(completedCount >= targetCount) reachedTarget = true;
    }

    const done = reachedTarget || terminalError || (!apStop && hasDone && used >= acts.length && !failed);

    if(!log.length && !done){
      if(apStep > 0){
        msg.apSummary = splitThink(msg.content || "").rest.trim() || "Автопилот остановился без следующего действия.";
        msg.content = (msg.content || "").trim() + "\n\n`ℹ️ Автопилот остановлен: модель не указала следующее действие`";
        await persist(c); renderMessages();
      }
      resetAutopilot(); return;
    }        // обычный ответ без действий
    text = text.replace(/`?\s*(\[DONE\]|\[CYCLE_DONE\]|\[ERROR:\s*[^\]]+\])\s*`?/gi, "").trim();
    if(terminalError) text += `${text ? "\n\n" : ""}Не удалось выполнить: ${terminalErrorMatch[1].trim()}`;

    // Сохраняем чистый итог для будущей истории API (без эмодзи-логов и «✅ Готово!»),
    // чтобы модель не имитировала UI-лог вместо команд [CLICK: ...] / [TYPE: ...]
    const plainProse = splitThink(text).rest.trim();
    if(reachedTarget){
      msg.apSummary = plainProse
        ? `${plainProse} (Выполнено ${completedCount} из ${targetCount}.)`
        : `Выполнено ${completedCount} из ${targetCount}.`;
    } else {
      msg.apSummary = plainProse || (okLabels.length ? `Выполнил действия: ${okLabels.slice(0, 5).join(", ")}.` : "Выполнил действия на странице.");
    }

    if(log.length) text += "\n\n" + log.map(l => "`"+l.replace(/`/g,"'")+"`").join("  \n");
    if(reachedTarget) text += `\n\n✅ Выполнено ${completedCount} из ${targetCount} — автопилот завершён!`;
    else if(apStop) text += "\n\n⏹ Остановлено";
    else if(done && !terminalError) text += targetCount > 0 ? `\n\n✅ Готово! Выполнено ${completedCount} из ${targetCount}.` : "\n\n✅ Готово!";
    msg.content = text; await persist(c); renderMessages();
    if(reachedTarget || done || apStop || current() !== c){ resetAutopilot(); return; }
    if(failed && !acted) apConsecutiveFailures++; else if(acted) apConsecutiveFailures = 0;
    if(apConsecutiveFailures >= 3){
      msg.content += "\n\nАвтопилот остановлен после трёх неудачных попыток. Проверьте страницу и попробуйте другой запрос.";
      await persist(c); renderMessages(); resetAutopilot(); return;
    }
    if(!acted && !failed){ resetAutopilot(); return; }
    const maxSteps = targetCount > 0 ? Math.max(AP_MAX_STEPS, Math.min(200, targetCount * 10)) : AP_MAX_STEPS;
    if(++apStep >= maxSteps){ resetAutopilot(); toast("Лимит шагов — напишите «продолжай»"); return; }
    if(failed && apFailed.length > 4) apFailed = apFailed.slice(-4);

    // пауза между шагами: ждём реального изменения страницы + выдерживаем минимальный интервал между запросами
    apStop = false;
    controller = new AbortController(); controller.signal.onabort = () => apStop = true; updateSendBtn();
    await waitStable(before);
    const rawDelay = settings.apDelay;
    const minIntervalMs = ((rawDelay === undefined || rawDelay === null || rawDelay === "") ? 6 : Math.max(0, parseFloat(rawDelay) || 0)) * 1000;
    if(!apStop && minIntervalMs > 0 && lastApiReqTs > 0){
      const leftMs = minIntervalMs - (Date.now() - lastApiReqTs);
      if(leftMs > 150){
        toast(`⏳ Пауза ${Math.ceil(leftMs / 1000)} с (лимит запросов)…`);
        const endAt = Date.now() + leftMs;
        while(!apStop && current() === c && Date.now() < endAt){
          await sleep(Math.min(200, endAt - Date.now()));
        }
      }
    }
    controller = null; updateSendBtn();
    if(apStop || current() !== c){
      if(apStop && current() === c){ msg.content += "\n\n⏹ Остановлено"; await persist(c); renderMessages(); }
      resetAutopilot(); return;
    }

    // Шаг цикла хранится только в RAM (apTrace) и не попадает в c.messages / IndexedDB / Supabase
    const progressLine = targetCount > 0 ? `\nВыполнено ${completedCount} из ${targetCount}.` : "";
    apTrace.push({
      assistant: rawModelText || acts.map(a => a.raws.join(" ")).join(" "),
      result: `(автопилот: шаг ${apStep} выполнен)${progressLine}\nРезультаты:\n${traceLines.join("\n")}\nПроверь по блоку [ЧТО ИЗМЕНИЛОСЬ] и актуальному списку элементов, что вышло, и продолжай со следующей невыполненной задачи. Когда ВСЕ задачи выполнены — итог + [DONE].`
    });
    generate();
  }
};

// --- меню «＋»: файл, скриншот, видеть страницу, размышления ---
if(settings.think === undefined) settings.think = false;
const plusBtn = document.getElementById("plusBtn"), plusMenu = document.getElementById("plusMenu");
const closeMenu = () => { plusMenu.classList.remove("show"); plusBtn.classList.remove("open"); };
plusBtn.onclick = e => { e.stopPropagation(); plusMenu.classList.toggle("show"); plusBtn.classList.toggle("open"); };
document.addEventListener("click", e => { if(!e.target.closest(".plus-wrap")) closeMenu(); });
document.addEventListener("keydown", e => { if(e.key === "Escape") closeMenu(); });

const MODES = {
  seePage: {btn:"seePageBtn", chip:"👁 Страница", on:"👁 ИИ видит страницу и может действовать", off:"Страница скрыта от ИИ"},
  think:   {btn:"thinkBtn",   chip:"💭 Размышления", on:"💭 Размышления включены: модель сначала думает", off:"Размышления выключены"}
};
function paintModes(){
  const chips = document.getElementById("modeChips"); chips.innerHTML = "";
  for(const [k, m] of Object.entries(MODES)){
    document.getElementById(m.btn).classList.toggle("on", !!settings[k]);
    if(!settings[k]) continue;
    const c = document.createElement("span"); c.className = "mode-chip";
    c.innerHTML = `${m.chip}<button title="Выключить">×</button>`;
    c.querySelector("button").onclick = () => toggleMode(k);
    chips.appendChild(c);
  }
}
function toggleMode(k){ settings[k] = !settings[k]; saveSettingsLS(); paintModes(); toast(settings[k] ? MODES[k].on : MODES[k].off); }
for(const k of Object.keys(MODES)) document.getElementById(MODES[k].btn).onclick = e => { e.stopPropagation(); toggleMode(k); };
document.getElementById("attachBtn").addEventListener("click", closeMenu);
paintModes();

// версия расширения из manifest.json
const EXT_VERSION = chrome.runtime?.getManifest?.().version || "2.8";
document.querySelectorAll("[data-ver]").forEach(el => { el.textContent = "v" + EXT_VERSION; });

// переключатель плавающей кнопки у полей ввода (синхронизируется с content.js через chrome.storage.local)
if(settings.floatBtn === undefined) settings.floatBtn = true;
function syncFloatBtnSetting(){
  const el = document.getElementById("floatBtnToggle");
  if(el) el.classList.toggle("on", !!settings.floatBtn);
  try{ chrome.storage?.local?.set?.({aichat_float_btn: !!settings.floatBtn}); }catch{}
}
const floatToggleEl = document.getElementById("floatBtnToggle");
if(floatToggleEl){
  floatToggleEl.onclick = e => {
    e.stopPropagation();
    settings.floatBtn = !settings.floatBtn;
    saveSettingsLS();
    syncFloatBtnSetting();
    toast(settings.floatBtn ? "✨ Плавающая кнопка у полей включена" : "Плавающая кнопка у полей скрыта");
  };
}
syncFloatBtnSetting();

// размышления: OpenRouter использует reasoning, остальные OpenAI-совместимые: reasoning_effort
HOOKS.transformBody = (body, provider) => {
  if(settings.seePage) body.temperature = 0.2;
  if(!settings.think) return;
  if(provider === "openrouter") body.reasoning = {effort:"high"};
  else body.reasoning_effort = "high";
};

document.getElementById("shotBtn").onclick = async () => {
  closeMenu();
  try{ const tab = await getTargetTab();
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {format:"jpeg", quality:75});
    pending.push({type:"image", name:"screenshot.jpg", dataUrl: await compressImage(dataUrl)}); renderPending(); toast("📸 Скриншот добавлен");
  }catch(e){ toast("Не удалось сделать скриншот: "+e.message); }
};

// ============ УМНАЯ ПОДСТАНОВКА (Smart Fill) ============
const SMART_FILL_PROMPT = `Ты встроенный инструмент «Умная подстановка» в браузере.
По контексту страницы, описанию поля ввода и короткому черновику пользователя подготовь готовый текст для подстановки прямо в это поле.

Сначала автоматически определи сценарий по URL, заголовку страницы, подсказке поля и контексту:

1. scenario = "generator" — генератор картинок или видео (Midjourney, Leonardo, Kling, Runway, Sora, Ideogram, Flux, Freepik, Hailuo, Pika, Kandinsky, Шедеврум, Recraft, Krea, Stable Diffusion и т.п. или поле с подсказкой для промпта):
   - Разверни короткую идею в подробный, выразительный, качественный промпт (объект, композиция, свет, атмосфера, стиль, детали, камера/движение для видео).
   - Язык: учитывай язык площадки; по умолчанию для генераторов пиши на естественном английском (если площадка русскоязычная, например Шедеврум/Kandinsky, или пользователь явно попросил на русском — пиши на русском).
   - Только сам готовый промпт, без вступлений вроде «Вот промпт:».

2. scenario = "reply" — мессенджер, почта, чат поддержки или фриланс-биржа (Telegram, WhatsApp, VK, Gmail, Яндекс.Почта, Outlook, Kwork, FL.ru, Avito, Upwork, Slack, Discord и т.п.):
   - Прочитай контекст диалога (последние видимые сообщения) и перепиши краткий набросок пользователя в естественный, спокойный, уверенный ответ от ЖЕНСКОГО лица (например: «посмотрела», «сделала», «уточнила», «готова»).
   - Строго БЕЗ канцелярита, подхалимства и штампов: запрещены «доброго времени суток», «с удовольствием помогу», «буду рада сотрудничеству», «заранее спасибо», «к сожалению, вынуждена», «уважаемый». Пиши живо, спокойно и по делу.
   - Проверь сообщения собеседника на спорные моменты или риски: торг / давление по цене, выход за рамки исходной задачи (бесплатные правки, допработы), нереалистичные сроки, сомнительные условия оплаты/предоплаты, грубость или манипуляция. Если есть риск — напиши короткое (1–2 предложения) практичное предупреждение на русском в поле "warning". Если рисков нет — "warning": "".

3. scenario = "post" — соцсеть, блог, отзыв или форма публикации (Instagram, Pinterest, X/Twitter, LinkedIn, Threads, VK пост, Telegram-канал, YouTube описание, Дзен, комментарии и т.п.):
   - Оформи черновик под формат и стиль площадки (структура, абзацы, лаконичность, уместные теги только если они реально приняты на площадке). Без воды и штампов.

4. scenario = "general" — любая другая форма или текстовое поле:
   - Аккуратно оформи и улучши черновик под назначение поля, сохраняя смысл и естественный тон (от женского лица, если от первого лица).

Верни СТРОГО валидный JSON-объект без пояснений вокруг:
{"scenario":"generator|reply|post|general","text":"готовый текст для поля","warning":"короткое предупреждение о риске или пустая строка"}`;

const SMART_SCENARIO_LABELS = {
  generator: "🎨 Промпт для генератора",
  reply:     "💬 Ответ в диалог",
  post:      "📣 Текст публикации",
  general:   "✍️ Умная подстановка"
};

let smartFillLast = null;
let smartAbort = null;

function parseSmartFillResponse(raw){
  const cleaned = splitThink(String(raw || "")).rest.trim();
  if(!cleaned) return {scenario:"general", text:"", warning:""};
  const candidates = [];
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fenced) candidates.push(fenced[1].trim());
  candidates.push(cleaned);
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if(firstBrace >= 0 && lastBrace > firstBrace) candidates.push(cleaned.slice(firstBrace, lastBrace + 1));

  for(const cand of candidates){
    try{
      const j = JSON.parse(cand);
      if(j && typeof j === "object" && typeof j.text === "string"){
        const sc = SMART_SCENARIO_LABELS[j.scenario] ? j.scenario : "general";
        return {
          scenario: sc,
          text: j.text.trim(),
          warning: typeof j.warning === "string" ? j.warning.trim() : ""
        };
      }
    }catch{}
  }
  return {
    scenario: "general",
    text: cleaned.replace(/^```[\w-]*\n?|\n?```$/g, "").trim(),
    warning: ""
  };
}

function renderSmartUI({busy = false, scenario = "", warning = "", error = "", hasUndo = !!smartFillLast} = {}){
  const btn = document.getElementById("smartFillBtn");
  const undoBtn = document.getElementById("smartUndoBtn");
  const card = document.getElementById("smartCard");
  const badge = document.getElementById("smartBadge");
  const warnEl = document.getElementById("smartWarn");
  const errEl = document.getElementById("smartErr");
  if(!btn) return;

  btn.classList.toggle("busy", !!busy);
  btn.textContent = busy ? "⏳ Подставляю… (отмена)" : "✨ Умная подстановка";
  if(undoBtn) undoBtn.style.display = hasUndo ? "" : "none";

  if(error){
    if(badge) badge.textContent = "✨ Умная подстановка";
    if(warnEl){ warnEl.textContent = ""; warnEl.classList.remove("show"); }
    if(errEl){ errEl.textContent = "⚠️ " + error; errEl.classList.add("show"); }
    if(card) card.classList.add("show");
    return;
  }
  if(errEl){ errEl.textContent = ""; errEl.classList.remove("show"); }
  if(scenario || warning){
    if(badge) badge.textContent = SMART_SCENARIO_LABELS[scenario] || "✨ Подставлено";
    if(warnEl){
      if(warning){ warnEl.textContent = "⚠️ " + warning; warnEl.classList.add("show"); }
      else { warnEl.textContent = ""; warnEl.classList.remove("show"); }
    }
    if(card) card.classList.add("show");
  } else if(!busy && card && !warning){
    card.classList.remove("show");
  }
}

async function collectSmartFieldContext(tab){
  const token = "sf_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
  const results = await chrome.scripting.executeScript({
    target: {tabId: tab.id, allFrames: true},
    args: [token],
    func: (tok) => {
      const IGNORED = new Set(["password","hidden","checkbox","radio","file","button","submit","reset","image","range","color","date","time","month","week"]);
      const clean = s => String(s || "").replace(/\s+/g, " ").trim();
      const isEditable = el => {
        if(!el || el.nodeType !== 1) return false;
        const tag = el.tagName?.toLowerCase();
        if(tag === "textarea") return !el.disabled && !el.readOnly;
        if(tag === "input") return !IGNORED.has((el.type || "text").toLowerCase()) && !el.disabled && !el.readOnly;
        if(el.isContentEditable) return true;
        const ce = el.getAttribute?.("contenteditable");
        return ce === "" || ce === "true" || ce === "plaintext-only";
      };
      const isVis = el => {
        if(!el || !el.isConnected) return false;
        const r = el.getBoundingClientRect();
        if(r.width < 20 || r.height < 14) return false;
        const s = getComputedStyle(el);
        return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
      };
      const deepActive = () => {
        let a = document.activeElement;
        while(a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
        let cur = a;
        while(cur){
          if(isEditable(cur)) return cur;
          if(cur.parentElement) cur = cur.parentElement;
          else if(cur.getRootNode && cur.getRootNode() instanceof ShadowRoot) cur = cur.getRootNode().host;
          else break;
        }
        return null;
      };
      const collectAllEditable = () => {
        const out = [];
        const roots = [document];
        for(let i = 0; i < roots.length; i++){
          const root = roots[i];
          for(const host of root.querySelectorAll("*")) if(host.shadowRoot && !roots.includes(host.shadowRoot)) roots.push(host.shadowRoot);
          for(const el of root.querySelectorAll('textarea, input, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"]')){
            if(isEditable(el) && isVis(el)) out.push(el);
          }
        }
        return out;
      };

      let target = null, priority = 0, lastTs = 0;
      const act = deepActive();
      if(act && isVis(act)){
        target = act; priority = 3; lastTs = Date.now();
      } else if(window.__aiLastInput && isEditable(window.__aiLastInput) && isVis(window.__aiLastInput)){
        target = window.__aiLastInput; priority = 2; lastTs = window.__aiLastInputTs || 1;
      } else {
        const all = collectAllEditable();
        let best = null, bestScore = -1;
        for(const el of all){
          const r = el.getBoundingClientRect();
          const tag = el.tagName.toLowerCase();
          const meta = `${el.getAttribute("placeholder")||""} ${el.getAttribute("aria-label")||""} ${el.name||""} ${el.id||""}`.toLowerCase();
          let score = Math.min(400, r.width) * 0.2 + Math.min(200, r.height);
          if(tag === "textarea" || el.isContentEditable) score += 200;
          if(/(prompt|message|reply|comment|post|сообщен|ответ|промпт|описан|текст|написать|чат)/i.test(meta)) score += 160;
          if(/(search|поиск|find|filter)/i.test(meta) && tag === "input") score -= 180;
          if(score > bestScore){ bestScore = score; best = el; }
        }
        if(best){ target = best; priority = 1; lastTs = 0; }
      }

      const pageMeta = { url: location.href, title: document.title || "", lang: document.documentElement?.lang || "" };
      if(!target) return { found: false, ...pageMeta };

      target.setAttribute("data-ai-smart-target", tok);
      const tag = target.tagName.toLowerCase();
      const isCE = !/^(input|textarea)$/.test(tag);
      const rawDraft = isCE ? (target.innerText || "").replace(/\r\n/g, "\n").replace(/\n$/, "") : (target.value || "");
      let labelText = "";
      if(target.id){
        try{ const lb = document.querySelector(`label[for="${CSS.escape(target.id)}"]`); if(lb) labelText = clean(lb.innerText); }catch{}
      }
      const placeholder = clean(target.getAttribute("placeholder") || target.getAttribute("data-placeholder") || "");
      const ariaLabel = clean(target.getAttribute("aria-label") || target.getAttribute("title") || labelText || target.name || "");

      // Собираем последние 5–8 видимых сообщений (для чатов/почты/бирж)
      const msgSelectors = '[data-message-id],[data-mid],[data-testid*="message" i],[class*="message-text" i],[class*="Message_"],[class*="chat-message" i],[class*="msg-text" i],[class*="bubble" i],article,[role="listitem"]';
      const msgCandidates = [];
      try{
        for(const node of document.querySelectorAll(msgSelectors)){
          if(node === target || node.contains(target) || target.contains(node)) continue;
          if(!isVis(node)) continue;
          const r = node.getBoundingClientRect();
          if(r.width < 40 || r.height < 14 || r.height > window.innerHeight * 0.9) continue;
          const txt = clean(node.innerText);
          if(txt.length < 2 || txt.length > 900) continue;
          msgCandidates.push({ node, txt, rect: r });
        }
      }catch{}
      const leafMsgs = msgCandidates.filter((item, idx) =>
        !msgCandidates.some((other, j) => j !== idx && item.node.contains(other.node))
      );
      const recentMessages = [];
      const seenTxt = new Set();
      for(const item of leafMsgs.slice(-14)){
        if(seenTxt.has(item.txt)) continue;
        seenTxt.add(item.txt);
        const cls = String(item.node.className || "").toLowerCase();
        const isOut = /(?:^|[\s_-])(out|outgoing|own|self|sent|mine|right|me)(?:$|[\s_-])/.test(cls);
        const isIn  = /(?:^|[\s_-])(in|incoming|received|other|peer|left)(?:$|[\s_-])/.test(cls);
        const prefix = isOut ? "[Моё] " : (isIn ? "[Собеседник] " : "");
        recentMessages.push(prefix + item.txt.slice(0, 360));
      }
      const lastMessages = recentMessages.slice(-8);

      // Компактный фрагмент видимого текста страницы
      const headings = [...document.querySelectorAll("h1,h2,h3")].filter(isVis).map(h => clean(h.innerText)).filter(Boolean).slice(0, 6);
      const bodyText = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
      const pageSnippet = (headings.length ? `Заголовки: ${headings.join(" | ")}\n\n` : "") + bodyText.slice(0, 1800);

      return {
        found: true,
        priority,
        lastTs,
        token: tok,
        tag: isCE ? "contenteditable" : tag,
        draft: rawDraft,
        placeholder,
        ariaLabel,
        recentMessages: lastMessages,
        pageSnippet: pageSnippet.slice(0, 2200),
        ...pageMeta
      };
    }
  });

  const frames = (results || []).filter(r => r.result && !r.error).map(({frameId, result}) => ({frameId, result}));
  const topFrame = frames.find(f => f.frameId === 0)?.result || null;
  const found = frames.filter(f => f.result.found);
  if(!found.length) return null;
  found.sort((a, b) =>
    (b.result.priority - a.result.priority) ||
    (b.result.lastTs - a.result.lastTs) ||
    ((b.frameId === 0 ? 1 : 0) - (a.frameId === 0 ? 1 : 0))
  );
  const win = found[0];
  return {
    tabId: tab.id,
    frameId: win.frameId,
    ...win.result,
    topUrl: topFrame?.url || win.result.url,
    topTitle: topFrame?.title || win.result.title
  };
}

async function writeSmartFieldText(tabId, frameId, token, newText){
  const [res] = await chrome.scripting.executeScript({
    target: {tabId, frameIds: [frameId]},
    args: [token, String(newText ?? "")],
    func: (tok, value) => {
      const IGNORED = new Set(["password","hidden","checkbox","radio","file","button","submit","reset","image","range","color","date","time","month","week"]);
      const isEditable = el => {
        if(!el || el.nodeType !== 1) return false;
        const tag = el.tagName?.toLowerCase();
        if(tag === "textarea") return !el.disabled && !el.readOnly;
        if(tag === "input") return !IGNORED.has((el.type || "text").toLowerCase()) && !el.disabled && !el.readOnly;
        return !!el.isContentEditable || ["","true","plaintext-only"].includes(el.getAttribute?.("contenteditable"));
      };
      const findMarked = () => {
        const roots = [document];
        for(let i = 0; i < roots.length; i++){
          const root = roots[i];
          const hit = tok ? root.querySelector(`[data-ai-smart-target="${tok}"]`) : null;
          if(hit) return hit;
          for(const host of root.querySelectorAll("*")) if(host.shadowRoot && !roots.includes(host.shadowRoot)) roots.push(host.shadowRoot);
        }
        return null;
      };
      let el = findMarked();
      if(!el || !el.isConnected){
        let a = document.activeElement;
        while(a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
        if(isEditable(a)) el = a;
        else if(window.__aiLastInput && window.__aiLastInput.isConnected && isEditable(window.__aiLastInput)) el = window.__aiLastInput;
      }
      if(!el) return {ok:false, msg:"Поле ввода больше недоступно на странице"};

      el.focus();
      const tag = el.tagName.toLowerCase();
      if(tag === "input" || tag === "textarea"){
        const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        const prevVal = el.value;
        if(setter) setter.call(el, value);
        else el.value = value;
        if(el._valueTracker){
          try{ el._valueTracker.setValue(prevVal === value ? "" : prevVal); }catch{}
        }
        try{ el.dispatchEvent(new InputEvent("input", {bubbles:true, cancelable:true, inputType: value ? "insertText" : "deleteContentBackward", data: value || null})); }
        catch{ el.dispatchEvent(new Event("input", {bubbles:true})); }
        el.dispatchEvent(new Event("change", {bubbles:true}));
      } else {
        try{
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
        }catch{}

        let applied = false;
        if(value === ""){
          try{ applied = document.execCommand("delete", false); }catch{}
          if((el.innerText || "").trim() !== ""){
            el.textContent = "";
            try{ el.dispatchEvent(new InputEvent("input", {bubbles:true, cancelable:true, inputType:"deleteContentBackward", data:null})); }
            catch{ el.dispatchEvent(new Event("input", {bubbles:true})); }
          }
        } else {
          try{ applied = document.execCommand("insertText", false, value); }catch{}
          const norm = s => String(s || "").replace(/\r\n/g, "\n").trim();
          if(!applied || norm(el.innerText) !== norm(value)){
            try{
              const dt = new DataTransfer();
              dt.setData("text/plain", value);
              el.dispatchEvent(new ClipboardEvent("paste", {bubbles:true, cancelable:true, clipboardData:dt}));
            }catch{}
          }
          if(norm(el.innerText) !== norm(value)){
            el.textContent = value;
            try{ el.dispatchEvent(new InputEvent("input", {bubbles:true, cancelable:true, inputType:"insertText", data:value})); }
            catch{ el.dispatchEvent(new Event("input", {bubbles:true})); }
          }
        }
        el.dispatchEvent(new Event("change", {bubbles:true}));
      }

      if(el.style){
        const oldOutline = el.style.outline;
        el.style.outline = "2px solid #34c77b";
        setTimeout(() => { el.style.outline = oldOutline; }, 750);
      }
      return {ok:true};
    }
  });
  return res?.result || {ok:false, msg:"Не удалось обновить поле ввода"};
}

async function callSmartFillAI(userContent, signal){
  const p = settings.provider;
  const key = settings.keys[p];
  const model = activeModel();
  const pDef = providerOf(p);
  if(!pDef) throw new Error(`Провайдер «${p}» не найден.`);
  if(!key && !isCustomProvider(p)) throw new Error(`Не указан API-ключ для «${pDef.name}».`);
  if(!model) throw new Error(`Не выбрана модель для «${pDef.name}».`);

  const body = {
    model,
    messages: [
      {role:"system", content: SMART_FILL_PROMPT},
      {role:"user", content: userContent}
    ],
    stream: false,
    temperature: 0.4
  };
  if(settings.maxTokens) body.max_tokens = +settings.maxTokens;
  const headers = {"Content-Type":"application/json"};
  if(key) headers["Authorization"] = "Bearer " + key;
  if(p === "openrouter"){
    headers["HTTP-Referer"] = location.origin.startsWith("http") ? location.origin : "https://localhost";
    headers["X-Title"] = "AI Chat HTML";
  }

  const MAX_RETRIES = 3;
  let res;
  for(let attempt = 0; attempt <= MAX_RETRIES; attempt++){
    lastApiReqTs = Date.now();
    res = await fetch(baseUrlOf(p) + "/chat/completions", {
      method: "POST", headers, body: JSON.stringify(body), signal
    });
    if(res.status === 429 && attempt < MAX_RETRIES){
      let t = await res.text();
      try{ const j = JSON.parse(t); t = j.error?.message || j.message || t; }catch{}
      const waitMs = parseRetryDelayMs(res, t, attempt);
      toast(`⏳ Лимит запросов (429), повтор через ${Math.max(1, Math.ceil(waitMs/1000))} с…`);
      await abortableSleep(waitMs, signal);
      continue;
    }
    break;
  }
  if(!res.ok){
    let t = await res.text();
    try{ const j = JSON.parse(t); t = j.error?.message || j.message || t; }catch{}
    throw new Error(`HTTP ${res.status}: ${String(t).slice(0, 300)}`);
  }
  const j = await res.json();
  if(j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  const m = j.choices?.[0]?.message || {};
  return typeof m.content === "string" ? m.content : (m.content || []).map(x => x.text || "").join("");
}

async function runSmartFill(){
  if(smartAbort){
    smartAbort.abort();
    return {ok:false, error:"Отменено"};
  }
  let tab;
  try{ tab = await getTargetTab(); }catch{}
  if(!tab || !/^(https?|file):/.test(tab.url || "")){
    const err = "На этой странице подстановка недоступна";
    renderSmartUI({error: err});
    toast(err);
    return {ok:false, error: err};
  }

  smartAbort = new AbortController();
  renderSmartUI({busy: true});
  try{
    const info = await collectSmartFieldContext(tab);
    if(!info){
      const err = "На странице не найдено активное поле ввода — кликните в нужное поле и повторите";
      renderSmartUI({error: err});
      toast("Кликните в поле ввода на странице");
      return {ok:false, error: err};
    }

    const panelInputEl = document.getElementById("input");
    const pageDraft = (info.draft || "").trim();
    const panelDraft = (panelInputEl?.value || "").trim();
    const draftText = pageDraft || panelDraft;
    const draftSource = pageDraft ? "page" : (panelDraft ? "panel" : "empty");

    if(!draftText && !(info.recentMessages && info.recentMessages.length)){
      const err = "Напишите короткий черновик в поле на странице или в поле боковой панели";
      renderSmartUI({error: err});
      toast("Введите короткий черновик");
      return {ok:false, error: err};
    }

    const contextLines = [
      `URL: ${info.topUrl || info.url}`,
      `Заголовок страницы: ${info.topTitle || info.title}`,
      info.lang ? `Язык страницы: ${info.lang}` : "",
      `Поле ввода: ${info.tag}` +
        (info.placeholder ? ` | placeholder: ${info.placeholder}` : "") +
        (info.ariaLabel ? ` | label: ${info.ariaLabel}` : ""),
      info.recentMessages?.length
        ? `\nПоследние видимые сообщения (${info.recentMessages.length}):\n` + info.recentMessages.map((m, i) => `${i + 1}. ${m}`).join("\n")
        : "",
      info.pageSnippet ? `\nФрагмент видимого текста страницы:\n${info.pageSnippet}` : "",
      draftText
        ? `\nЧерновик пользователя (${draftSource === "page" ? "из поля на странице" : "из боковой панели"}):\n${draftText}`
        : "\nЧерновик пользователя пуст: предложи короткий естественный ответ по последним сообщениям диалога."
    ].filter(Boolean).join("\n");

    const rawReply = await callSmartFillAI(contextLines, smartAbort.signal);
    const parsed = parseSmartFillResponse(rawReply);
    if(!parsed.text) throw new Error("Модель вернула пустой текст");

    // Сохраняем исходный черновик до подстановки (для кнопки «Вернуть исходный текст»)
    smartFillLast = {
      tabId: info.tabId,
      frameId: info.frameId,
      token: info.token,
      originalFieldText: info.draft || "",
      draftSource,
      generatedText: parsed.text,
      scenario: parsed.scenario,
      warning: parsed.warning
    };

    const writeRes = await writeSmartFieldText(info.tabId, info.frameId, info.token, parsed.text);
    if(!writeRes.ok) throw new Error(writeRes.msg || "Не удалось вставить текст в поле");

    renderSmartUI({scenario: parsed.scenario, warning: parsed.warning, hasUndo: true});
    toast(parsed.warning ? "✨ Подставлено (есть предупреждение)" : "✨ Текст подставлен в поле");
    return {ok:true, scenario: parsed.scenario, warning: parsed.warning};
  }catch(err){
    if(err.name === "AbortError"){
      renderSmartUI({busy: false});
      toast("Умная подстановка отменена");
      return {ok:false, error:"Отменено"};
    }
    const msg = err.message === "Failed to fetch" ? "Нет связи с API (Failed to fetch)" : (err.message || String(err));
    renderSmartUI({error: msg});
    return {ok:false, error: msg};
  }finally{
    smartAbort = null;
    const btn = document.getElementById("smartFillBtn");
    if(btn){ btn.classList.remove("busy"); btn.textContent = "✨ Умная подстановка"; }
  }
}

async function undoSmartFill(){
  if(!smartFillLast) return;
  const saved = smartFillLast;
  try{
    const r = await writeSmartFieldText(saved.tabId, saved.frameId, saved.token, saved.originalFieldText);
    if(r.ok){
      smartFillLast = null;
      renderSmartUI({hasUndo: false});
      toast("↩️ Исходный текст возвращён");
      return;
    }
  }catch{}
  try{
    if(saved.originalFieldText) await navigator.clipboard.writeText(saved.originalFieldText);
    toast(saved.originalFieldText ? "Поле недоступно — исходный текст скопирован в буфер" : "Поле больше недоступно");
  }catch{
    toast("Поле больше недоступно на странице");
  }
}

const smartFillBtn = document.getElementById("smartFillBtn");
if(smartFillBtn) smartFillBtn.onclick = () => runSmartFill();
const smartUndoBtn = document.getElementById("smartUndoBtn");
if(smartUndoBtn) smartUndoBtn.onclick = () => undoSmartFill();
const smartCopyBtn = document.getElementById("smartCopyBtn");
if(smartCopyBtn) smartCopyBtn.onclick = async () => {
  if(!smartFillLast?.generatedText) return;
  try{ await navigator.clipboard.writeText(smartFillLast.generatedText); toast("Скопировано"); }catch{}
};
const smartCloseBtn = document.getElementById("smartCloseBtn");
if(smartCloseBtn) smartCloseBtn.onclick = () => {
  const card = document.getElementById("smartCard");
  if(card) card.classList.remove("show");
};

try{
  chrome.runtime?.onMessage?.addListener?.((req, sender, sendResponse) => {
    if(req && req.type === "SMART_FILL_RUN"){
      runSmartFill().then(sendResponse).catch(e => sendResponse({ok:false, error: e.message || String(e)}));
      return true;
    }
  });
}catch{}












