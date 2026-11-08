import { getPreferenceForTheme, normalizeThemePreference, resolveThemePreference } from '../lib/theme.mjs';
const header = document.querySelector('.site-header');
const navToggle = document.querySelector('.nav-toggle');
const navLinks = document.querySelector('.nav-links');
const themeToggle = document.querySelector('.theme-toggle');
const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
const themeStorageKey = 'mearl-website-theme';
const labels = document.documentElement.dataset;

function getStoredThemePreference() {
  try {
    return normalizeThemePreference(localStorage.getItem(themeStorageKey));
  } catch {
    return 'system';
  }
}

function getSystemTheme() {
  return themeMedia.matches ? 'dark' : 'light';
}

let themePreference = document.documentElement.dataset.themePreference
  ? normalizeThemePreference(document.documentElement.dataset.themePreference)
  : getStoredThemePreference();

function applyTheme(theme) {
  const dark = theme === 'dark';
  const label = dark ? labels.themeLightLabel : labels.themeDarkLabel;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelectorAll('[data-theme-image]').forEach(image => {
    if (!(image instanceof HTMLImageElement)) return;
    const source = dark ? image.dataset.darkSrc : image.dataset.lightSrc;
    if (source && image.getAttribute('src') !== source) image.src = source;
  });
  themeToggle?.setAttribute('aria-label', label);
  themeToggle?.setAttribute('title', label);
}

applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

themeToggle?.addEventListener('click', event => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  const updateTheme = () => {
    themePreference = getPreferenceForTheme(theme, getSystemTheme());
    document.documentElement.dataset.themePreference = themePreference;
    try {
      localStorage.setItem(themeStorageKey, themePreference);
    } catch {
      // The active page still switches theme when persistent storage is unavailable.
    }
    applyTheme(theme);
  };

  if (!document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    updateTheme();
    return;
  }

  const root = document.documentElement;
  const toggleRect = themeToggle.getBoundingClientRect();
  const fromPointer = event instanceof MouseEvent && event.detail > 0;
  const x = fromPointer ? event.clientX : toggleRect.left + toggleRect.width / 2;
  const y = fromPointer ? event.clientY : toggleRect.top + toggleRect.height / 2;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const returnsToSystemTheme = theme === getSystemTheme();
  const directionClass = returnsToSystemTheme ? 'theme-transition-in' : 'theme-transition-out';
  const clipPath = returnsToSystemTheme
    ? [`circle(${radius}px at ${x}px ${y}px)`, `circle(0 at ${x}px ${y}px)`]
    : [`circle(0 at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`];

  root.classList.add('theme-transition', directionClass);
  const transition = document.startViewTransition(updateTheme);
  let maskAnimation;
  transition.ready
    .then(() => {
      maskAnimation = root.animate(
        { clipPath },
        {
          duration: returnsToSystemTheme ? 360 : 420,
          easing: 'cubic-bezier(.22, .76, .2, 1)',
          fill: 'forwards',
          pseudoElement: returnsToSystemTheme
            ? '::view-transition-old(root)'
            : '::view-transition-new(root)',
        },
      );
    })
    .catch(() => {});
  transition.finished.finally(() => {
    maskAnimation?.cancel();
    root.classList.remove('theme-transition', directionClass);
  });
});

themeMedia.addEventListener?.('change', event => {
  if (themePreference !== 'system') return;
  applyTheme(event.matches ? 'dark' : 'light');
});

window.addEventListener('storage', event => {
  if (event.key === themeStorageKey) {
    themePreference = normalizeThemePreference(event.newValue);
    document.documentElement.dataset.themePreference = themePreference;
    applyTheme(resolveThemePreference(themePreference, getSystemTheme()));
  }
});

function updateHeader() {
  header?.classList.toggle('is-scrolled', window.scrollY > 8);
}

updateHeader();
window.addEventListener('scroll', updateHeader, { passive: true });

navToggle?.addEventListener('click', () => {
  const open = navLinks?.classList.toggle('is-open') ?? false;
  navToggle.setAttribute('aria-expanded', String(open));
});

navLinks?.addEventListener('click', event => {
  if (!(event.target instanceof Element) || !event.target.closest('a')) return;
  navLinks.classList.remove('is-open');
  navToggle?.setAttribute('aria-expanded', 'false');
});

document.querySelectorAll('a[data-locale-link="section"]').forEach(link => {
  link.addEventListener('click', () => {
    if (link instanceof HTMLAnchorElement) link.hash = window.location.hash;
  });
});

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const input = document.createElement('textarea');
  input.value = value;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  // Legacy browsers without the Clipboard API still require the synchronous copy command.
  const legacyDocument = /** @type {{ execCommand(commandId: string): boolean }} */ (document);
  try {
    if (!legacyDocument.execCommand('copy')) throw new Error('Copy failed');
  } finally {
    input.remove();
  }
}

document.querySelectorAll('[data-copy-target]').forEach(button => {
  const original = button.textContent;
  let resetTimer;
  button.addEventListener('click', async () => {
    const selector = button.getAttribute('data-copy-target');
    const target = selector ? document.querySelector(selector) : null;
    if (!target) return;

    window.clearTimeout(resetTimer);
    try {
      await copyText(target.textContent.trim());
      button.textContent = labels.copied;
    } catch {
      button.textContent = labels.copyFailed;
    }
    resetTimer = window.setTimeout(() => {
      button.textContent = original;
    }, 1600);
  });
});
