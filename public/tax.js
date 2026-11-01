// Tax and business: deductible spend by ATO category with its receipts,
// business income and expenses, per financial year (1 July to 30 June), and the
// CSV export and the accountant pack zip. the owner is not GST registered, so there
// is no GST anywhere.
'use strict';

async function downloadCsv(fy, btn) {
  const out = $('#csverr');
  if (out) out.innerHTML = '';
  try {
    await withBusy(btn, 'Preparing the file', async () => {
      if (demoActive()) throw demoNoDownload();
      const res = await fetch(`/api/tax/export.csv?fy=${fy}`, { credentials: 'same-origin', redirect: 'manual' });
      if (res.type === 'opaqueredirect' || res.status === 401) throw new ApiError('Signed out', 'The sign-in gate session expired. Sign in again to carry on.', { signedOut: true });
      if (!res.ok) throw new ApiError('Export failed', `${res.status} ${(await res.json().catch(() => null))?.error ?? res.statusText}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `mint-fy${fy}.csv`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
    toast(`Exported ${fyLabel(fy)}`);
    buzz(12);
  } catch (e) {
    const msg = e.offline ? 'The export needs a connection.' : e.detail ?? e.message;
    if (out) out.innerHTML = `<div class="error"><div class="h">Couldn't export</div><div class="d">${esc(msg)}</div><button class="btn ghost" type="button" id="csvretry">${I.refresh}Retry</button></div>`;
    $('#csvretry')?.addEventListener('click', () => downloadCsv(fy, $('#csvbtn')));
  }
}

const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// The accountant pack: one zip for the year, built on the server (it has the
// receipts), then downloaded. Stepped progress, the real error text and Retry.
async function downloadPack(fy, info) {
  const box = $('#packbox');
  const btn = $('#packbtn');
  if (!box || !btn || btn.disabled) return;
  const steps = [`Gathering ${plural(info.deductions, 'deduction')} and ${plural(info.receipts, 'receipt')}`, 'Zipping the summary, CSVs and receipts', 'Downloading', 'Saved'];
  let bar = null;
  const paint = (at, extra = '') => {
    box.innerHTML = `<div class="card packprog" role="status" aria-live="polite"><ol class="steps">${steps.map((t, i) => `<li class="${i < at || at === 3 ? 'done' : i === at ? 'now' : ''}"><span class="dot">${i < at || at === 3 ? I.check : i === at ? '<span class="spin dim"></span>' : ''}</span><span>${esc(i === 2 && extra ? `${t} ${extra}` : t)}</span></li>`).join('')}</ol>${at === 2 ? '<div class="meter" role="progressbar" aria-label="Download progress" aria-valuemin="0" aria-valuemax="100"><i id="packbar"></i></div>' : ''}</div>`;
    bar = $('#packbar', box);
  };
  btn.disabled = true;
  $('#csvbtn')?.setAttribute('disabled', '');
  btn.setAttribute('aria-busy', 'true');
  paint(0);
  box.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  const stopSlow = slowNote($('.packprog', box), 4500, 'Still working. A year with many receipts takes a little while.');
  const step1 = setTimeout(() => { if ($('.packprog', box) && !bar) paint(1); }, 900);
  try {
    if (demoActive()) throw demoNoDownload();
    const res = await fetch(`/api/tax/pack?fy=${fy}`, { credentials: 'same-origin', redirect: 'manual' });
    if (res.type === 'opaqueredirect' || res.status === 401) throw new ApiError('Signed out', 'The sign-in gate session expired. Sign in again to carry on.', { signedOut: true });
    if (!res.ok) throw new ApiError('Pack failed', `${res.status} ${(await res.json().catch(() => null))?.error ?? res.statusText}`);
    clearTimeout(step1);
    const total = Number(res.headers.get('content-length')) || 0;
    paint(2, total ? `0 of ${fmtBytes(total)}` : '');
    const parts = [];
    let got = 0;
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        if (bar && total) bar.style.transform = `scaleX(${Math.min(1, got / total)})`;
      }
    } else parts.push(new Uint8Array(await res.arrayBuffer()));
    if (total && got !== total) throw new ApiError('Download cut short', `Got ${got} of ${total} bytes. Retry to fetch it again.`);
    const blob = new Blob(parts, { type: 'application/zip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mint-fy${fy}-accountant-pack.zip`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    paint(3);
    $('.packprog', box)?.insertAdjacentHTML('beforeend', `<p class="sub">${esc(a.download)} · ${esc(fmtBytes(blob.size))}</p>`);
    toast(`Accountant pack ready for ${fyLabel(fy)}`);
    buzz(12);
  } catch (e) {
    clearTimeout(step1);
    const msg = e.offline ? 'The pack needs a connection.' : e.detail ?? e.message;
    box.innerHTML = `<div class="error"><div class="h">Couldn't build the pack</div><div class="d">${esc(msg)}</div><button class="btn ghost" type="button" id="packretry">${I.refresh}Retry</button></div>`;
    $('#packretry', box)?.addEventListener('click', () => downloadPack(fy, info));
  } finally {
    stopSlow();
    btn.disabled = !online;
    btn.removeAttribute('aria-busy');
    $('#csvbtn')?.toggleAttribute('disabled', !online);
  }
}

function deductionRow(d) {
  return `<button class="row ded" type="button" data-tx="${esc(d.transaction_id)}"><div class="main"><div class="t1">${esc(d.merchant || d.description || 'Unnamed')}</div><div class="t2">${esc(dmy(d.date))} · ${esc(acctText(d.account_name))}${d.note ? ` · ${esc(d.note)}` : ''}</div></div>
    <div class="amt"><div class="num">${esc(money(d.deductible_amount))}</div><div class="t2">${d.receipts ? `<span class="chip ok">${I.camera}${d.receipts}</span>` : '<span class="chip warn">No receipt</span>'}</div></div></button>`;
}

async function viewTax(el, token) {
  const nowFy = fyOfIso(todayIso());
  const p = new URLSearchParams(location.search);
  let fy = /^\d{4}$/.test(p.get('fy') ?? '') ? Number(p.get('fy')) : nowFy;
  let missingOnly = false;
  let sum = null;
  let ded = null;
  const open = new Set(store.get('tax-open') ?? []);

  el.innerHTML = `<div class="mnav"><button class="x" type="button" id="fprev" aria-label="Previous financial year" title="Previous financial year">${I.back}</button><div class="mname" id="fname" aria-live="polite">${esc(fyLabel(fy))}${fy === nowFy ? ' · this year' : ''}</div><button class="x" type="button" id="fnext" aria-label="Next financial year" title="Next financial year" ${fy >= nowFy ? 'disabled' : ''}>${I.chevron}</button></div><div id="estbox"></div><div id="taxbox"></div>`;
  const box = $('#taxbox', el);
  const est = taxEstimateCard($('#estbox', el), { fy, token });
  const go = (n) => { history.replaceState({}, '', n === nowFy ? '/tax' : `/tax?fy=${n}`); render({ keepScroll: false }); };
  $('#fprev', el).addEventListener('click', () => { buzz(6); go(fy - 1); });
  $('#fnext', el).addEventListener('click', () => { buzz(6); go(fy + 1); });

  const paint = () => {
    if (token !== renderToken || !sum || !ded) return;
    const d = sum.deductions;
    const b = sum.business;
    const items = missingOnly ? ded.items.filter((x) => !x.receipts) : ded.items;
    const groups = sum.deductions.by_category.map((c) => ({ ...c, items: items.filter((x) => x.ato_category === c.code) })).filter((c) => !missingOnly || c.items.length);
    const empty = !d.count && !b.by_category.length;
    box.innerHTML = empty
      ? `<div class="card">${emptyState({ icon: I.receipt, title: `Nothing tagged for ${fyLabel(fy)}`, line: 'Tag deductible spend from a transaction.', action: { href: '/transactions', label: 'Find a transaction' } })}</div>`
      : `<section class="card month">
          ${cardHead(I.receipt, 'Deductions', `Tagged <b class="num">${d.count}</b>`)}
          <div class="big2 num">${esc(money(d.total))}</div>
          ${d.count ? `<div class="mline"><span>${sum.receipts.attached} with receipts</span><span class="${sum.receipts.missing ? 'warnc' : ''}">${sum.receipts.missing ? `${sum.receipts.missing} missing` : 'All receipts attached'}</span></div>` : ''}
        </section>
        <section class="grid2 mt10"><div class="stat"><div class="k">Business income</div><div class="v num pos">${esc(money(b.income))}</div></div><div class="stat"><div class="k">Business expenses</div><div class="v num">${esc(money(b.expenses))}</div></div></section>
        <div class="stat mt10 net"><div class="k">Business net</div><div class="v num ${b.net < 0 ? 'neg-red' : 'pos'}">${esc(money(b.net))}</div></div>
        <div class="sec-head"><h2>Deductions</h2>${sum.receipts.missing ? `<button class="fchip ${missingOnly ? 'on' : ''}" type="button" id="missing">${I.camera}Missing receipts</button>` : ''}</div>
        ${groups.length ? `<div class="acc stagger">${groups.map((c) => `<section class="agroup ${open.has(c.code) ? 'open' : ''}" data-g="${esc(c.code)}">
            <button class="row" type="button" data-toggle="${esc(c.code)}" aria-expanded="${open.has(c.code)}"><div class="main"><div class="t1">${esc(c.label)}</div><div class="t2">${esc(c.code.startsWith('D') ? c.code : c.group)} · ${plural(c.count, 'item')}</div></div><div class="amt num">${esc(money(c.amount))}</div><span class="caret">${I.chevron}</span></button>
            <div class="abody"><div class="abody-in">${c.items.map(deductionRow).join('')}</div></div></section>`).join('')}</div>`
          : d.count ? `<div class="card">${emptyState({ icon: I.camera, title: 'All receipts attached', line: 'Every deduction in this year has a receipt.' })}</div>` : `<div class="card"><p class="sub">No deductions tagged yet.</p></div>`}
        ${b.by_category.filter((c) => c.income || c.expenses).length ? `<div class="sec-head"><h2>Business by category</h2><a class="fchip" href="/transactions?business=1&from=${sum.from}&to=${sum.to}" data-nav>${I.list}See all</a></div>
          <div class="rows">${b.by_category.filter((c) => c.income || c.expenses).map((c) => `<div class="row"><div class="main"><div class="t1">${esc(c.category)}</div></div><div class="amt">${c.income ? `<div class="num pos">${esc(money(c.income))}</div>` : ''}${c.expenses ? `<div class="num">${esc(money(-c.expenses))}</div>` : ''}</div></div>`).join('')}</div>` : ''}`;
    box.insertAdjacentHTML('beforeend', `<div class="export"><button class="btn wide" type="button" id="csvbtn">${I.download}Export ${esc(fyLabel(fy))} as CSV</button><div id="csverr"></div>
      <button class="btn wide ghost" type="button" id="packbtn">${I.receipt}Accountant pack for ${esc(fyLabel(fy))}</button>
      <div id="packbox"></div></div>`);
    $('#csvbtn', box).title = online ? `Download every deduction and business transaction for ${fyLabel(fy)}` : 'Offline: the export needs a connection';
    $('#packbtn', box).title = online ? `Download a zip for your accountant covering ${fyLabel(fy)}` : 'Offline: the pack needs a connection';
    if (!online) { $('#csvbtn', box).disabled = true; $('#packbtn', box).disabled = true; }
    setPaneDefault(() => `<h2>${esc(fyLabel(fy))}</h2><div class="card"><div class="big2 num">${esc(money(d.total))}</div><div class="sub">${plural(d.count, 'deduction')} · ${sum.receipts.missing} without a receipt</div></div>`);
  };

  const load = () => Promise.all([
    swr(`/api/tax/summary?fy=${fy}`, (d) => { sum = d; paint(); }),
    swr(`/api/tax/deductions?fy=${fy}`, (d) => { ded = d; paint(); }),
  ]).catch((e) => {
    if (token !== renderToken) return;
    box.innerHTML = errorCard(e, 'taxretry', 'the tax summary');
    $('#taxretry', box)?.addEventListener('click', () => { box.innerHTML = skeletonCard(130); applyDims(box); load(); });
  });
  if (!store.get(`c:/api/tax/summary?fy=${fy}`)) { box.innerHTML = `${skeletonCard(130)}<h2>Deductions</h2>${skeletonRows(4)}`; applyDims(box); }
  load();

  box.addEventListener('click', (e) => {
    const t = e.target.closest('[data-toggle]');
    if (t) {
      const g = t.closest('.agroup');
      const code = t.dataset.toggle;
      const on = !g.classList.contains('open');
      g.classList.toggle('open', on);
      t.setAttribute('aria-expanded', String(on));
      if (on) open.add(code); else open.delete(code);
      store.set('tax-open', [...open]);
      buzz(5);
      return;
    }
    const tx = e.target.closest('[data-tx]');
    if (tx) return openTxById(tx.dataset.tx);
    if (e.target.closest('#missing')) { missingOnly = !missingOnly; buzz(6); paint(); return; }
    const csv = e.target.closest('#csvbtn');
    if (csv) downloadCsv(fy, csv);
    if (e.target.closest('#packbtn')) downloadPack(fy, { deductions: sum?.deductions.count ?? 0, receipts: sum?.receipts.attached ?? 0 });
  });
  const onTx = () => { if (token === renderToken) { load(); est.reload(); } };
  document.addEventListener('mint:txchanged', onTx);
  cleanup.push(() => document.removeEventListener('mint:txchanged', onTx));
}
