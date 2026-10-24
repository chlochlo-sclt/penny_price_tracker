// Thin wrapper over chrome.storage, shared by the popup and background worker.
//   area "local": this device only (dev settings, watches)
//   area "sync":  follows the user's Chrome profile (slider preferences)
// When the popup is previewed as a plain web page there is no chrome.storage,
// so it falls back to localStorage. Reads never throw: on any failure they
// return `fallback`.

async function storageGet(area, key, fallback) {
  try {
    if (globalThis.chrome?.storage?.[area]) {
      const stored = await chrome.storage[area].get(key);
      return stored[key] ?? fallback;
    }
    const raw = localStorage.getItem(`${area}:${key}`);
    return raw == null ? fallback : JSON.parse(raw);
  } catch (err) {
    console.warn(`[placeholder] couldn't read ${area}.${key}`, err);
    return fallback;
  }
}

async function storageSet(area, key, value) {
  try {
    if (globalThis.chrome?.storage?.[area]) {
      await chrome.storage[area].set({ [key]: value });
    } else {
      localStorage.setItem(`${area}:${key}`, JSON.stringify(value));
    }
    return true;
  } catch (err) {
    console.warn(`[placeholder] couldn't save ${area}.${key}`, err);
    return false;
  }
}
