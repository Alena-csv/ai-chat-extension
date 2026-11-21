// ============ РАСШИРЕНИЕ: видит страницу + автопилот ============
const AP_MAX_STEPS = 50;          // шагов автопилота до остановки
const AP_MAX_ACTIONS = 10;        // действий за один ответ модели
const AP_MAX_ITEMS = 400;         // сколько элементов показывать модели
const AP_MAX_CLICKS = 1000;       // максимум кликов в одной команде [CLICK: id | N]
let apStep = 0, apStop = false;
let apConsecutiveFailures = 0;
let apPrev = null;                // прошлый снимок (для диффа)
let apFailed = [];                // что уже не сработало — модели нельзя повторять
let apScreenshot = null;
let apReadText = "";
const sleep = ms => new Promise(r => setTimeout(r, ms));
if(settings.seePage === undefined) settings.seePage = true;

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
      const el = /^\d+$/.test(selector) ? roots.map(root=>root.querySelector(`[data-ai-id="${selector}"]`)).find(Boolean) : null;
      if(!el) return {ok:false, msg:"элемент не найден"};
      const r = el.getBoundingClientRect(), o = {bubbles:true, clientX:r.left+r.width/2, clientY:r.top+r.height/2};
      el.dispatchEvent(new PointerEvent("pointerover",o)); el.dispatchEvent(new MouseEvent("mouseover",o));
      return {ok:true, msg:`наведено: ${(el.innerText||el.getAttribute("aria-label")||el.tagName).trim().slice(0,50)}`};
    }
    const s = t.replace(/^[`'"#№]+|[`'"]+$/g,"");
    const roots = [document];
    for(let i=0;i<roots.length;i++) for(const host of roots[i].querySelectorAll("*")) if(host.shadowRoot) roots.push(host.shadowRoot);
    let el = /^\d+$/.test(s) ? roots.map(root=>root.querySelector(`[data-ai-id="${s}"]`)).find(Boolean) : null;
    if(!el){ try{ for(const root of roots){ el = root.querySelector(s); if(el) break; } }catch{} }
    if(!el){ const low = s.toLowerCase(); el = roots.flatMap(root=>[...root.querySelectorAll("a,button,[role=button],input,label,summary,div,span")])
      .find(e => (e.innerText||e.value||e.getAttribute("aria-label")||"").trim().toLowerCase() === low); }
    if(!el) return {ok:false, msg:"элемент не найден (возможно, страница перерисовалась — обнови снимок через [SCROLL])"};
    el.scrollIntoView({block:"center"});
    const name = (el.innerText||el.value||el.getAttribute("aria-label")||el.placeholder||el.tagName).trim().slice(0,50);
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
    return {ok:true, msg:name};
  }});
  return res?.result || {ok:false, msg:"нет результата"};
}

async function clickMany(target, count, delayMs){
  if(count <= 1) return actOnPage("click", target, "");
  if(count >= 10) toast(`🖱 Кликаю ×${count} (⏹ — остановить)`);
  let done = 0, lastName = target;
  for(let i = 0; i < count; i++){
    if(apStop) break;
    const r = await actOnPage("click", target, "");
    if(!r.ok){
      if(done === 0) return r;
      return {ok:true, msg:`${lastName} ×${done}/${count} (остановлено: ${r.msg})`};
    }
    done++;
    if(r.msg) lastName = r.msg;
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
  async transformMessages(msgs){
    if(!settings.seePage) return msgs;
    const snap = await pageSnapshot();
    const sys = msgs[0]?.role === "system" ? msgs[0] : null;
    if(sys) sys.content = AP_PROMPT + "\n\n" + sys.content; else msgs.unshift({role:"system", content:AP_PROMPT});
    const ctx = buildCtx(snap, apStep > 0 ? "diff" : "full", msgs);
    apPrev = snap && !snap.blocked ? snap : null;
    for(let i = msgs.length-1; i >= 0; i--){
      if(msgs[i].role !== "user") continue;
      if(typeof msgs[i].content === "string") msgs[i].content += ctx;
      else { const t = msgs[i].content.find(p => p.type === "text"); t ? t.text += ctx : msgs[i].content.unshift({type:"text", text:ctx}); }
      if(apReadText){
        const readContext = `\n\n[ДОПОЛНИТЕЛЬНЫЙ ТЕКСТ СТРАНИЦЫ]\n${apReadText}`;
        if(typeof msgs[i].content === "string") msgs[i].content += readContext;
        else {
          const t = msgs[i].content.find(p=>p.type==="text");
          if(t) t.text += readContext; else msgs[i].content.unshift({type:"text",text:readContext});
        }
        apReadText = "";
      }
      if(apScreenshot){
        const image = {type:"image_url", image_url:{url:apScreenshot}};
        if(typeof msgs[i].content === "string") msgs[i].content = [{type:"text", text:msgs[i].content}, image];
        else msgs[i].content.push(image);
        apScreenshot = null;
      }
      break;
    }
    return msgs;
  },

  async afterGenerate(c, msg, aborted){
    if(aborted || msg.error || !settings.seePage){ apStep = 0; return; }
    let text = msg.content || "";
    const log = []; let acted = false, failed = false;

    // одно сканирование в порядке появления — действия выполняются как написаны
    const executableText = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
    const RE = /\[(TYPE|CLICK|ENTER|SELECT|OPEN|SCROLL|WAIT|KEY|HOVER|READ|BACK|SHOT)(?::\s*([^\]\n]*))?\]/gi;
    const rawActs = [...executableText.matchAll(RE)].map(m=>({kind:m[1].toLowerCase(), arg:(m[2]||"").trim(), raw:m[0]}));
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
          for(let j = used; j < acts.length; j++) for(const raw of acts[j].raws) text = text.replace(raw, "");
          break;
        }
        const icon = {type:"⌨️", click:"🖱", enter:"↵", select:"▾", open:"🌐", scroll:"↕️", wait:"⏳", key:"⌨️", hover:"↗️", read:"📖", back:"↩️", shot:"📸"}[a.kind] || "•";
        const hasTargetId = /^(click|type|enter|select|hover)$/.test(a.kind) && a.target;
        try{
          const r = a.kind === "click"
            ? await clickMany(a.target, a.count, a.delayMs)
            : await actOnPage(a.kind, a.target, a.value);
          if(r.ok){
            log.push(hasTargetId ? `${icon} [${a.target}] ${r.msg}` : `${icon} ${r.msg}`);
            acted = true;
          } else {
            log.push(`⚠️ ${a.kind} ${a.target}: ${r.msg}`); failed = true;
            if(apFailed.length < 6 && !apFailed.includes(`${a.kind} ${a.target}`)) apFailed.push(`${a.kind} ${a.target} — ${r.msg}`);
          }
        }catch(e){ log.push(`⚠️ ${a.kind}: ${e.message}`); failed = true; }
        for(const raw of a.raws) text = text.replace(raw, "");
        used++;
        if(!apStop && a.kind !== "wait" && a.kind !== "scroll") await sleep(200);
      }
    } finally {
      if(controller){ controller = null; updateSendBtn(); }
    }

    const executableRemainder = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
    const terminalErrorMatch = executableRemainder.match(/\[ERROR:\s*([^\]]+)\]/i);
    const terminalError = !!terminalErrorMatch;
    const done = terminalError || (!apStop && /\[DONE\]/.test(executableRemainder) && used >= acts.length && !failed);

    if(!log.length && !done){ apStep = 0; return; }        // обычный ответ без действий
    text = text.replace(/\[DONE\]|\[ERROR:\s*[^\]]+\]/gi, "").trim();
    if(terminalError) text += `${text ? "\n\n" : ""}Не удалось выполнить: ${terminalErrorMatch[1].trim()}`;
    if(log.length) text += "\n\n" + log.map(l => "`"+l+"`").join("  \n");
    if(apStop) text += "\n\n⏹ Остановлено";
    else if(done && !terminalError) text += "\n\n✅ Готово!";
    msg.content = text; await persist(c); renderMessages();
    if(done || apStop || current() !== c){ apStep = 0; apConsecutiveFailures = 0; apFailed = []; return; }
    if(failed && !acted) apConsecutiveFailures++; else if(acted) apConsecutiveFailures = 0;
    if(apConsecutiveFailures >= 3){
      msg.content += "\n\nАвтопилот остановлен после трёх неудачных попыток. Проверьте страницу и попробуйте другой запрос.";
      await persist(c); renderMessages(); apStep = 0; apFailed = []; apConsecutiveFailures = 0; return;
    }
    if(!acted && !failed){ apStep = 0; return; }
    if(++apStep >= AP_MAX_STEPS){ apStep = 0; toast("Лимит шагов — напишите «продолжай»"); return; }
    if(failed && apFailed.length > 4) apFailed = apFailed.slice(-4);

    // пауза между шагами: ждём реального изменения страницы, кнопка ⏹ работает и здесь
    apStop = false;
    controller = new AbortController(); controller.signal.onabort = () => apStop = true; updateSendBtn();
    await waitStable(before);
    controller = null; updateSendBtn();
    if(apStop || current() !== c){ apStep = 0; return; }
    c.messages.push({role:"user", auto:true, time:Date.now(), content:
      `(автопилот: шаг ${apStep} выполнен) Проверь по блоку «что изменилось» и актуальному списку элементов, что вышло, и продолжай со следующей невыполненной задачи. Когда ВСЕ задачи выполнены — итог + [DONE].`});
    await persist(c);
    generate();
  }
};

// новый запрос пользователя сбрасывает счётчик шагов и память об ошибках
document.getElementById("sendBtn").addEventListener("click", () => { if(!controller){ apStep = 0; apConsecutiveFailures = 0; apFailed = []; apPrev = null; } }, true);
document.getElementById("input").addEventListener("keydown", e => { if(e.key==="Enter" && !e.shiftKey){ apStep = 0; apConsecutiveFailures = 0; apFailed = []; apPrev = null; } }, true);

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












