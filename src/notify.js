// Download notices. Each download event row holds its own title, so a notice
// never depends on the transfer row (spec/Transfer.tla, NoLostNotice).

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtTime = (ms) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(ms)) + ' (GMT+8)';

export function buildNotice(events, origin) {
  const title = events[0].title || 'Untitled transfer';
  const n = events.length;
  const subject = n === 1 ? `Downloaded: ${title}` : `Downloaded ${n} times: ${title}`;
  const lines = events.map((e) => {
    const where = [e.city, e.country].filter(Boolean).join(', ') || 'Unknown location';
    return { text: `${fmtTime(e.at)} | ${e.what} | ${where} | IP ${e.ip || '-'} | ${e.ua || '-'}`, e, where };
  });
  const text = [`Transfer: ${title}`, `Link: ${origin}/d/${events[0].transfer_id}`, '', ...lines.map((l) => l.text)].join('\n');
  const rows = lines
    .map(({ e, where }) => `<tr><td style="padding:6px 10px;border-top:1px solid #e5e7eb">${esc(fmtTime(e.at))}</td><td style="padding:6px 10px;border-top:1px solid #e5e7eb">${esc(e.what)}</td><td style="padding:6px 10px;border-top:1px solid #e5e7eb">${esc(where)}<br><span style="color:#6b7280;font-size:12px">IP ${esc(e.ip || '-')}</span></td><td style="padding:6px 10px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px">${esc(e.ua || '-')}</td></tr>`)
    .join('');
  const html = `<div style="font-family:system-ui,sans-serif;color:#111827"><p>Your transfer <b>${esc(title)}</b> was downloaded.</p><table style="border-collapse:collapse;font-size:14px"><tr style="text-align:left;color:#6b7280"><th style="padding:6px 10px">Time</th><th style="padding:6px 10px">What</th><th style="padding:6px 10px">Where</th><th style="padding:6px 10px">Device</th></tr>${rows}</table><p style="color:#6b7280;font-size:12px">Transfer</p></div>`;
  return { subject, text, html };
}

// Send pending notices. With onlyTransfer, try that transfer now (cooldown applies).
export async function flushNotices(env, origin, now = Date.now(), onlyTransfer = null) {
  const cooldown = Number(env.NOTIFY_COOLDOWN_SECONDS ?? 600) * 1000;
  const to = String(env.NOTIFY_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!to.length) return 0;
  const ids = onlyTransfer
    ? [onlyTransfer]
    : (await env.DB.prepare('SELECT DISTINCT transfer_id FROM downloads WHERE notified = 0 LIMIT 50').all()).results.map((r) => r.transfer_id);
  let sent = 0;
  for (const tid of ids) {
    const t = await env.DB.prepare('SELECT last_notified_at FROM transfers WHERE id = ?').bind(tid).first();
    if (t && now - t.last_notified_at < cooldown) continue;
    const { results: events } = await env.DB.prepare('SELECT * FROM downloads WHERE transfer_id = ? AND notified = 0 ORDER BY at LIMIT 200').bind(tid).all();
    if (!events.length) continue;
    const msg = buildNotice(events, origin);
    try {
      await env.EMAIL.send({ from: { email: env.NOTIFY_FROM, name: 'Transfer' }, to, subject: msg.subject, text: msg.text, html: msg.html });
    } catch (err) {
      console.error('notice send failed', tid, err?.message || err);
      continue; // events stay pending; the next cron run tries again
    }
    const marks = [];
    for (let i = 0; i < events.length; i += 90) {
      const chunk = events.slice(i, i + 90).map((e) => e.id);
      marks.push(env.DB.prepare(`UPDATE downloads SET notified = 1 WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk));
    }
    marks.push(env.DB.prepare('UPDATE transfers SET last_notified_at = ? WHERE id = ?').bind(now, tid));
    await env.DB.batch(marks);
    sent++;
  }
  return sent;
}
