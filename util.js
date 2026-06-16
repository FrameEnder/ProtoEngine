import crypto from 'crypto';

export function uid() {
  return crypto.randomBytes(12).toString('hex');
}

// Trim and clamp a string to a max length. Returns '' for non-strings.
export function clampStr(v, max) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

// Validate a username: 3-32 chars, letters/numbers/_/-/. only.
export function validUsername(u) {
  return typeof u === 'string' && /^[A-Za-z0-9_.-]{3,32}$/.test(u);
}

// Password must be at least 8 chars.
export function validPassword(p) {
  return typeof p === 'string' && p.length >= 8 && p.length <= 200;
}

// Normalize a URL and ensure it uses http/https. Returns null if invalid.
export function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

// Parse tags from an array or comma-separated string into a clean array.
export function parseTags(input) {
  let arr = [];
  if (Array.isArray(input)) arr = input;
  else if (typeof input === 'string') arr = input.split(',');
  const seen = new Set();
  const out = [];
  for (let t of arr) {
    if (typeof t !== 'string') continue;
    t = t.trim().toLowerCase().slice(0, 30);
    if (!t) continue;
    if (!/^[a-z0-9 +#.&_-]+$/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 15) break;
  }
  return out;
}

// Canonical list of customizable theme color keys (used by the custom theme).
// Keep in sync with the CSS variables in styles.css (--ct-* overrides) and the
// editor in the frontend. Each entry: { key, label, var }.
export const THEME_COLOR_KEYS = [
  { key: 'bg',            label: 'Background',                 var: '--bg' },
  { key: 'topbar',        label: 'Top bar',                    var: '--topbar' },
  { key: 'btnBg',         label: 'Button background',          var: '--btn-bg' },
  { key: 'surface',       label: 'Panel / search bar',         var: '--surface' },
  { key: 'searchbar',     label: 'Search bar',                 var: '--searchbar' },
  { key: 'border',        label: 'Borders',                    var: '--border' },
  { key: 'text',          label: 'Text',                       var: '--text' },
  { key: 'textHover',     label: 'Hovered text',               var: '--text-hover' },
  { key: 'subtext',       label: 'Hero subtext / dim text',    var: '--text-dim' },
  { key: 'btnHover',      label: 'Hovered button',             var: '--surface-hover' },
  { key: 'btnClick',      label: 'Clicked button',             var: '--blue-press' },
  { key: 'btnClickText',  label: 'Clicked button text',        var: '--btn-text' },
  { key: 'searchBtn',     label: 'Search button',              var: '--search-btn' },
  { key: 'icon',          label: 'Icons',                      var: '--icon' },
  { key: 'glass',         label: 'Frosted glass hue',          var: '--glass' },
  { key: 'brandFirst',    label: 'Corner logo — first letter', var: '--brand-first' },
  { key: 'brandRest',     label: 'Corner logo — the rest',     var: '--brand-rest' },
  { key: 'hero1',         label: 'Hero array — color 1',       var: '--blue' },
  { key: 'hero2',         label: 'Hero array — color 2',       var: '--red' },
  { key: 'hero3',         label: 'Hero array — color 3',       var: '--amber' },
  { key: 'hero4',         label: 'Hero array — color 4',       var: '--green' },
  { key: 'starOn',        label: 'Favorite star — selected',   var: '--star-on' },
  { key: 'starOff',       label: 'Favorite star — unselected', var: '--star-off' },
  { key: 'link',          label: 'Links',                      var: '--link' },
];

// Validate a hex color (#rgb, #rgba, #rrggbb, #rrggbbaa).
export function validHexColor(v) {
  return typeof v === 'string' && /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v.trim());
}

// Keep only valid, known color keys with valid hex values. Two meta keys are
// allowed through: _hazeOn ('1'|'0') and _hazeColor (hex) for the bg haze.
export function sanitizeThemeColors(obj) {
  const allowed = new Set(THEME_COLOR_KEYS.map((k) => k.key));
  const out = {};
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (allowed.has(k) && validHexColor(v)) out[k] = v.trim();
    }
    if (obj._hazeOn === '1' || obj._hazeOn === '0') out._hazeOn = obj._hazeOn;
    if (validHexColor(obj._hazeColor)) out._hazeColor = obj._hazeColor.trim();
  }
  return out;
}
