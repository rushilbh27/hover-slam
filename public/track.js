// Small usage counts for the developer page: a visit, a descent started, a descent finished. Only a random id kept in this browser,
// the level, the result and whether it is a phone. Nothing is sent from localhost, or when the browser says Do Not Track.
import { clientId } from './feedback.js';

const quiet = () => {
  try {
    if (navigator.doNotTrack === '1') return true;
    return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && localStorage.getItem('hs.track') !== '1';
  } catch { return true; }
};

export function track(kind, data = {}) {
  if (quiet()) return;
  const device = window.matchMedia('(pointer: coarse)').matches || innerWidth < 700 ? 'phone' : 'desktop';
  try {
    fetch('/api/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, client_id: clientId(), device, ...data }), keepalive: true }).catch(() => {});
  } catch { /* counting must never get in the way of the game */ }
}

// once per browser session
export function trackVisit() {
  try {
    if (sessionStorage.getItem('hs.visit')) return;
    sessionStorage.setItem('hs.visit', '1');
  } catch { /* storage blocked: count it anyway */ }
  track('visit');
}
