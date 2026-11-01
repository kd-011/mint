// Settings (/settings, under More). Two sections: the fingerprint lock (its
// card and its calls live in lockset.js) and Demo mode, which hands the phone
// round without showing the real money. The switch and Shuffle numbers change
// this device's own setting (localStorage, see core.js and demo-math.js), so
// nothing in this file is sent anywhere and nothing waits on the network. More
// sections are added as further cards in SETTINGS_SECTIONS.
'use strict';

const demoCard = () => {
  const on = demoActive();
  const waiting = queue.all().length;
  return `<section class="card set-card" id="set-demo">
    ${cardHead(I.phone, 'Demo mode', `<span class="chip ${on ? 'warn' : ''}" id="set-demo-state">${on ? 'On' : 'Off'}</span>`)}
    <div class="set-row">
      <div class="main"><div class="t1">Scale every amount</div></div>
      ${switchHtml('data-demo-switch', 'demo', on, 'Demo mode', on ? 'Demo mode is on: tap to turn it off' : 'Demo mode is off: tap to turn it on')}
    </div>
    <div class="set-row">
      <div class="main"><div class="t1">New scale</div><div class="t2" id="set-shuffle-line">${on ? 'Pick a new scale for every amount.' : 'Turn on demo mode first.'}</div></div>
      <button class="btn ghost sm" type="button" id="set-shuffle" ${on ? '' : 'disabled'} title="${on ? 'Pick a new random scale' : 'Turn on demo mode to shuffle the numbers'}">${I.refresh}Shuffle numbers</button>
    </div>
    ${on && waiting ? `<p class="sub set-note">${esc(plural(waiting, 'saved change'))} waiting to sync. They send once demo mode is off.</p>` : ''}
    ${on ? '<p class="sub set-note">CSV and tax downloads are off while demo mode is on, because they carry your real figures.</p>' : ''}
  </section>`;
};

// Each section is a function returning a card, so a new one is one line here.
const SETTINGS_SECTIONS = [lockCard, demoCard];

async function viewSettings(el) {
  el.innerHTML = `<div class="settings">${SETTINGS_SECTIONS.map((f) => f()).join('')}</div>`;
  stagger($('.settings', el), ':scope > .card');

  // The screen shows no dollars, so a change repaints it in place (the switch keeps focus)
  // instead of redrawing the whole page.
  const paint = () => {
    const had = document.activeElement?.matches?.('[data-demo-switch]');
    $('.settings', el).innerHTML = SETTINGS_SECTIONS.map((f) => f()).join('');
    if (had) $('[data-demo-switch]', el)?.focus({ preventScroll: true });
    if (desktop.matches) paneDefault();
  };
  document.addEventListener('mint:demo', paint);
  cleanup.push(() => document.removeEventListener('mint:demo', paint));
  wireLockCard(el);

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-demo-switch]')) {
      const next = !demoActive();
      setDemo(next);
      buzz(next ? 14 : 8);
      toast(next ? 'Demo mode on. Numbers are scaled.' : 'Demo mode off. Real numbers are back.');
      return;
    }
    const shuffle = e.target.closest('#set-shuffle');
    if (shuffle && !shuffle.disabled) {
      shuffleDemo();
      buzz(10);
      toast('Numbers shuffled');
    }
  });
}
