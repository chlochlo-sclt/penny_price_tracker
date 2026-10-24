// Settings shared by the side panel and the background worker. Both load this as
// a classic script (sidepanel.html <script>, background.js importScripts), so
// these constants are globals in each.

// The backend (app/main.py). Must also be listed in host_permissions in
// manifest.json, or Chrome blocks the request.
const API_BASE_URL = "http://127.0.0.1:8000";
const REQUEST_TIMEOUT_MS = 10_000;
