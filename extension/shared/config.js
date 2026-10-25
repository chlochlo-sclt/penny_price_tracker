// Settings shared by the side panel and the background worker. Both load this as
// a classic script (sidepanel.html <script>, background.js importScripts), so
// these constants are globals in each.

// The backend (app/main.py). Must also be listed in host_permissions in
// manifest.json, or Chrome blocks the request.
const API_BASE_URL = "http://127.0.0.1:8000";
const REQUEST_TIMEOUT_MS = 10_000;

// Background price checks (GET /watch-check) can cost Apify credits, so they
// are rationed. See background/background.js for how these are used.
const WATCH_CHECK_INTERVAL_HOURS = 12; // alarm period, and the minimum gap per watch
const WATCH_CHECKS_PER_DAY = 5; // safety cap across all watches
const DEV_CHECK_COOLDOWN_MINUTES = 10; // dev tools "check price now"
const DEV_CHECK_AT_KEY = "devCheckAt"; // chrome.storage.local: its last use
