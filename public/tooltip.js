// Hover tooltips for anything with a data-tip. One floating plate is reused for every target.
//   data-tip="Engine"            the label
//   data-key="Space"             a key to show as a keycap beside it
//   data-tip-detail="..."        a line of explanation underneath
//   data-tip-pos="top|bottom|left|right"   where it opens (top by default); it flips if there is no room
// It opens after a short pause on hover or at once on keyboard focus, closes on leave, blur, Esc or a press, and never opens on
// a touch screen, where there is no hover.
export function initTooltips() {
  if (window.matchMedia && window.matchMedia('(hover: none)').matches) return;
  const tip = document.createElement('div');
  tip.id = 'tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let target = null, timer = 0, lastShown = 0;

  const fill = (el) => {
    tip.textContent = '';
    const head = document.createElement('div');
    head.className = 'tip-head';
    const label = document.createElement('span');
    label.className = 'tip-t';
    label.textContent = el.dataset.tip;
    head.appendChild(label);
    if (el.dataset.key) {
      const k = document.createElement('kbd');
      k.className = 'cap';
      k.textContent = el.dataset.key;
      head.appendChild(k);
    }
    tip.appendChild(head);
    if (el.dataset.tipDetail) {
      const d = document.createElement('div');
      d.className = 'tip-d';
      d.textContent = el.dataset.tipDetail;
      tip.appendChild(d);
    }
  };

  const place = (el) => {
    const r = el.getBoundingClientRect(), gap = 10, m = 8;
    tip.style.left = '0px'; tip.style.top = '0px';
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const room = { top: r.top - gap - h >= m, bottom: r.bottom + gap + h <= innerHeight - m, left: r.left - gap - w >= m, right: r.right + gap + w <= innerWidth - m };
    let pos = el.dataset.tipPos || 'top';
    if (!room[pos]) pos = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[pos];
    if (!room[pos]) pos = ['top', 'bottom', 'right', 'left'].find((p) => room[p]) || pos;
    let x = pos === 'left' ? r.left - gap - w : pos === 'right' ? r.right + gap : r.left + r.width / 2 - w / 2;
    let y = pos === 'top' ? r.top - gap - h : pos === 'bottom' ? r.bottom + gap : r.top + r.height / 2 - h / 2;
    x = Math.min(Math.max(m, x), innerWidth - w - m);
    y = Math.min(Math.max(m, y), innerHeight - h - m);
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
    tip.dataset.pos = pos;
  };

  const show = (el) => {
    if (!el.dataset.tip) return;
    target = el;
    fill(el);
    tip.classList.add('on');
    place(el);
    el.setAttribute('aria-describedby', 'tip');
    lastShown = performance.now();
  };
  const hide = () => {
    clearTimeout(timer);
    if (target) target.removeAttribute('aria-describedby');
    target = null;
    tip.classList.remove('on');
    lastShown = performance.now();
  };
  const find = (n) => (n && n.closest ? n.closest('[data-tip]') : null);

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = find(e.target);
    if (!el || el === target) return;
    clearTimeout(timer);
    const quick = performance.now() - lastShown < 400; // moving along a row of buttons: no second wait
    timer = setTimeout(() => show(el), quick && tip.classList.contains('on') ? 0 : 380);
  });
  document.addEventListener('pointerout', (e) => {
    const el = find(e.target);
    if (!el) return;
    const to = find(e.relatedTarget);
    if (to === el) return;
    clearTimeout(timer);
    if (target === el) hide();
  });
  document.addEventListener('focusin', (e) => { const el = find(e.target); if (el && e.target.matches && e.target.matches(':focus-visible')) show(el); });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', (e) => { if (e.code === 'Escape') hide(); }, true);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
  // a label that changes while it is open (sound on or off) is redrawn in place
  new MutationObserver(() => { if (target) { fill(target); place(target); } }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-tip', 'data-key', 'data-tip-detail'] });
}
