// ============ Умная подстановка: трекинг активного поля + плавающая кнопка ============
(() => {
  if (window.__aiSmartContentInit) return;
  window.__aiSmartContentInit = true;

  const IGNORED_INPUT_TYPES = new Set([
    "password", "hidden", "checkbox", "radio", "file",
    "button", "submit", "reset", "image", "range", "color", "date", "time", "month", "week"
  ]);

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName?.toLowerCase();
    if (tag === "textarea") return !el.disabled && !el.readOnly;
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      return !IGNORED_INPUT_TYPES.has(t) && !el.disabled && !el.readOnly;
    }
    if (el.isContentEditable) return true;
    const ce = el.getAttribute?.("contenteditable");
    if (ce === "" || ce === "true" || ce === "plaintext-only") return true;
    return false;
  }

  function findEditableFromTarget(node) {
    let cur = node;
    while (cur) {
      if (isEditable(cur)) return cur;
      if (cur.parentElement) cur = cur.parentElement;
      else if (cur.getRootNode && cur.getRootNode() instanceof ShadowRoot) cur = cur.getRootNode().host;
      else break;
    }
    return null;
  }

  function isVisibleLarge(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 22) return false;
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  }

  let floatEnabled = true;
  try {
    chrome.storage?.local?.get?.(["aichat_float_btn"], res => {
      if (res && res.aichat_float_btn === false) {
        floatEnabled = false;
        hideBtn();
      }
    });
    chrome.storage?.onChanged?.addListener?.((changes, area) => {
      if (area === "local" && changes.aichat_float_btn) {
        floatEnabled = changes.aichat_float_btn.newValue !== false;
        if (!floatEnabled) hideBtn();
        else if (activeEl && isVisibleLarge(activeEl)) showBtnFor(activeEl);
      }
    });
  } catch {}

  let host = null, btn = null, tip = null;
  let activeEl = null;
  let busy = false;
  let hideTimer = 0, tipTimer = 0;

  function ensureUI() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.setAttribute("data-ai-smart-float", "1");
    host.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;top:0;left:0;display:none;";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        .wrap { position: relative; display: inline-flex; align-items: center; gap: 6px; pointer-events: auto; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
        .btn {
          width: 26px; height: 26px; border-radius: 50%;
          border: 1px solid rgba(107, 147, 255, 0.55);
          background: rgba(15, 28, 64, 0.92); color: #e6ecff;
          display: inline-flex; align-items: center; justify-content: center;
          font-size: 13px; line-height: 1; cursor: pointer; padding: 0;
          box-shadow: 0 3px 10px rgba(0, 0, 0, 0.35);
          transition: transform .12s ease, background .12s ease, opacity .12s ease;
          opacity: 0.82;
        }
        .btn:hover { opacity: 1; background: #4d7cff; transform: scale(1.07); }
        .btn.busy { opacity: 1; background: #1a2e66; cursor: progress; }
        .btn.ok { opacity: 1; background: #1e7e4e; border-color: #34c77b; }
        .btn.err { opacity: 1; background: #9b2234; border-color: #ff5d73; }
        .tip {
          display: none; position: absolute; right: 32px; top: 50%; transform: translateY(-50%);
          white-space: nowrap; font-size: 11px; color: #e6ecff;
          background: rgba(10, 20, 48, 0.95); border: 1px solid rgba(107, 147, 255, 0.45);
          border-radius: 6px; padding: 3px 7px; box-shadow: 0 3px 10px rgba(0, 0, 0, 0.35);
          pointer-events: none;
        }
        .tip.show { display: inline-block; }
      </style>
      <div class="wrap">
        <span class="tip"></span>
        <button class="btn" type="button" title="Умная подстановка (AI Chat)">✨</button>
      </div>
    `;
    btn = shadow.querySelector(".btn");
    tip = shadow.querySelector(".tip");

    // Не забираем фокус у поля ввода при клике по плавающей кнопке
    btn.addEventListener("mousedown", e => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      triggerSmartFill();
    });

    (document.documentElement || document.body).appendChild(host);
  }

  function showTip(text, ms = 2400) {
    if (!tip) return;
    tip.textContent = text;
    tip.classList.add("show");
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => tip.classList.remove("show"), ms);
  }

  function positionBtn(el) {
    if (!host || !el || !isVisibleLarge(el)) { hideBtn(); return; }
    const r = el.getBoundingClientRect();
    const size = 26;
    const top = Math.max(4, Math.min(window.innerHeight - size - 4, r.bottom - size - 6));
    const left = Math.max(4, Math.min(window.innerWidth - size - 4, r.right - size - 6));
    host.style.top = `${Math.round(top)}px`;
    host.style.left = `${Math.round(left)}px`;
    host.style.display = "block";
  }

  function showBtnFor(el) {
    if (!floatEnabled || !isVisibleLarge(el)) return;
    clearTimeout(hideTimer);
    ensureUI();
    activeEl = el;
    positionBtn(el);
  }

  function hideBtn() {
    if (busy) return;
    if (host) host.style.display = "none";
  }

  function recordInput(el) {
    if (!el || !isEditable(el)) return;
    window.__aiLastInput = el;
    window.__aiLastInputTs = Date.now();
    activeEl = el;
    showBtnFor(el);
  }

  document.addEventListener("focusin", e => {
    const raw = e.composedPath ? e.composedPath()[0] : e.target;
    const el = findEditableFromTarget(raw);
    if (el) recordInput(el);
  }, true);

  document.addEventListener("input", e => {
    const raw = e.composedPath ? e.composedPath()[0] : e.target;
    const el = findEditableFromTarget(raw);
    if (el) {
      window.__aiLastInput = el;
      window.__aiLastInputTs = Date.now();
      activeEl = el;
      if (floatEnabled && host && host.style.display === "block") positionBtn(el);
    }
  }, true);

  document.addEventListener("focusout", () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!busy) hideBtn();
    }, 180);
  }, true);

  const reposition = () => {
    if (activeEl && host && host.style.display === "block") positionBtn(activeEl);
  };
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);

  function triggerSmartFill() {
    if (busy) return;
    const el = activeEl && activeEl.isConnected ? activeEl : window.__aiLastInput;
    if (el && el.isConnected) {
      window.__aiLastInput = el;
      window.__aiLastInputTs = Date.now();
    }
    busy = true;
    btn.classList.remove("ok", "err");
    btn.classList.add("busy");
    btn.textContent = "⏳";

    try {
      chrome.runtime.sendMessage({ type: "SMART_FILL_RUN" }, res => {
        busy = false;
        btn.classList.remove("busy");
        if (chrome.runtime.lastError || !res) {
          btn.classList.add("err");
          btn.textContent = "✨";
          showTip("Откройте панель AI Chat (Alt+A)", 2800);
          setTimeout(() => btn.classList.remove("err"), 1500);
          return;
        }
        if (res.ok) {
          btn.classList.add("ok");
          btn.textContent = "✓";
          if (res.warning) showTip("⚠️ Есть предупреждение в панели", 3000);
          setTimeout(() => { btn.classList.remove("ok"); btn.textContent = "✨"; }, 1400);
        } else {
          btn.classList.add("err");
          btn.textContent = "!";
          showTip(res.error || "Ошибка подстановки", 2800);
          setTimeout(() => { btn.classList.remove("err"); btn.textContent = "✨"; }, 1600);
        }
      });
    } catch {
      busy = false;
      btn.classList.remove("busy");
      btn.textContent = "✨";
      showTip("Обновите страницу", 2400);
    }
  }
})();
