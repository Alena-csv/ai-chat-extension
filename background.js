// Клик по иконке (или Alt+A): открываем боковую панель,
// а если браузер её не поддерживает (Яндекс, Opera, старый Chrome) — отдельное окно справа.
const PAGE = "sidepanel.html";

if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}

async function openWindow() {
  const url = chrome.runtime.getURL(PAGE);
  const existing = await chrome.tabs.query({ url });
  if (existing.length) { await chrome.windows.update(existing[0].windowId, { focused: true }); return; }
  let w = {};
  try { w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }); } catch {}
  const width = 440;
  await chrome.windows.create({
    url, type: "popup", width,
    height: w.height || 820,
    left: Math.max(0, (w.left ?? 0) + (w.width ?? 1280) - width),
    top: w.top ?? 0
  });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (chrome.sidePanel?.open) {
    try { await chrome.sidePanel.open({ windowId: tab.windowId }); return; }
    catch (e) { console.warn("sidePanel.open failed, fallback to window:", e); }
  }
  openWindow();
});
