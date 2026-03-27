#!/usr/bin/env node
'use strict';

// ── env ───────────────────────────────────────────────────────────────────────

const KLAVIYO_KEY   = process.env.KLAVIYO_PRIVATE_KEY;
const NOTION_TOKEN  = process.env.NOTION_TOKEN;
const PAGE_ID       = process.env.NOTION_PAGE_ID;
const LIST_ID       = process.env.KLAVIYO_LIST_ID;
const SEGMENT_ID    = process.env.KLAVIYO_SEGMENT_ID;
const RECHARGE_KEY  = process.env.RECHARGE_API_KEY;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function kv(path, opts = {}, retry = 3) {
  const res = await fetch(`https://a.klaviyo.com/api/${path}`, {
    ...opts,
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_KEY}`,
      revision: '2024-10-15',
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });
  if (res.status === 429 && retry > 0) {
    const wait = parseInt(res.headers.get('Retry-After') ?? '2', 10) * 1000;
    await new Promise(r => setTimeout(r, wait));
    return kv(path, opts, retry - 1);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Klaviyo /${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

async function notion(path, opts = {}) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion /${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

// ── Recharge ──────────────────────────────────────────────────────────────────

async function rc(path) {
  const res = await fetch(`https://api.rechargeapps.com/${path}`, {
    headers: {
      'X-Recharge-Access-Token': RECHARGE_KEY,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Recharge /${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

async function getActiveSubscriptionCount() {
  const { count } = await rc('subscriptions/count?status=active');
  return count;
}

async function getNewSubscriptionsThisMonth() {
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const { count } = await rc(`subscriptions/count?created_at_min=${start}`);
  return count;
}

async function getCancelledThisMonth() {
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const { count } = await rc(`subscriptions/count?status=cancelled&cancelled_at_min=${start}`);
  return count;
}

// ── Klaviyo: profile counts ───────────────────────────────────────────────────

// Both the newsletter list and engaged segment are Klaviyo segments
async function getSegmentCount(segmentId) {
  const { data } = await kv(`segments/${segmentId}/?additional-fields[segment]=profile_count`);
  return data.attributes.profile_count;
}

// ── Klaviyo: 30-day open rate ─────────────────────────────────────────────────

async function getMetricId(name) {
  let url = 'metrics/?fields[metric]=name';
  while (url) {
    const json = await kv(url);
    const match = json.data.find(m => m.attributes.name === name);
    if (match) return match.id;
    const next = json.links?.next;
    url = next ? next.replace('https://a.klaviyo.com/api/', '') : null;
  }
  throw new Error(`Klaviyo metric not found: "${name}"`);
}

async function getMetricTotal(metricId, start, end) {
  const filter = `greater-or-equal(datetime,${start}),less-than(datetime,${end})`;
  const { data } = await kv('metric-aggregates/', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'metric-aggregate',
        attributes: {
          metric_id: metricId,
          measurements: ['unique'],
          interval: 'month',
          page_size: 500,
          filter,
        },
      },
    }),
  });
  const values = (data.attributes.data ?? []).flatMap(d => d.measurements?.unique ?? []);
  return values.reduce((sum, v) => sum + (v ?? 0), 0);
}

async function get30DayOpenRate() {
  const end   = new Date();
  const start = new Date(end - 30 * 24 * 60 * 60 * 1000);
  const fmt   = d => d.toISOString().replace(/\.\d{3}Z$/, '+00:00');

  const [openedId, deliveredId] = await Promise.all([
    getMetricId('Opened Email'),
    getMetricId('Received Email'),
  ]);

  const [opens, delivered] = await Promise.all([
    getMetricTotal(openedId,    fmt(start), fmt(end)),
    getMetricTotal(deliveredId, fmt(start), fmt(end)),
  ]);

  if (!delivered) return 'N/A';
  return `${((opens / delivered) * 100).toFixed(1)}%`;
}

// ── Notion: find table ────────────────────────────────────────────────────────

async function getBlocks(blockId) {
  const results = [];
  let cursor;
  do {
    const qs   = cursor ? `?start_cursor=${cursor}` : '';
    const page = await notion(`blocks/${blockId}/children${qs}`);
    results.push(...page.results);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return results;
}

async function findScoreboardTableId(pageId) {
  const blocks       = await getBlocks(pageId);
  let   afterHeading = false;

  for (const block of blocks) {
    if (!afterHeading) {
      const hType = ['heading_1', 'heading_2', 'heading_3'].find(t => block.type === t);
      if (hType) {
        const text = block[hType].rich_text.map(r => r.plain_text).join('');
        if (text.includes('Live Scoreboard')) afterHeading = true;
      }
      continue;
    }
    if (block.type === 'table') return block.id;
    if (['heading_1', 'heading_2', 'heading_3'].includes(block.type)) break;
  }
  throw new Error('Could not find a table block after the "Live Scoreboard" heading');
}

// ── Notion: update rows ───────────────────────────────────────────────────────

function richText(value) {
  return [{ type: 'text', text: { content: String(value) } }];
}

async function updateRow(row, colIdx, value) {
  const updatedCells = row.table_row.cells.map((cell, i) =>
    i === colIdx ? richText(value) : cell
  );
  await notion(`blocks/${row.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ table_row: { cells: updatedCells } }),
  });
}

async function updateNotion(activeSubscriptions, newThisMonth, churnThisMonth, listCount, segmentCount, openRate) {
  const tableId = await findScoreboardTableId(PAGE_ID);
  const rows    = await getBlocks(tableId);
  if (!rows.length) throw new Error('Scoreboard table has no rows');

  const headerCells = rows[0].table_row.cells;
  const currentCol  = headerCells.findIndex(cell =>
    cell.map(t => t.plain_text).join('').toLowerCase().includes('current')
  );
  if (currentCol === -1) throw new Error('"Current" column not found in table header row');

  const updates = {
    'Monthly Subscribers':    activeSubscriptions,
    'New This Month':         newThisMonth,
    'Churn This Month':       churnThisMonth,
    'Email List Size':        listCount,
    'Engaged Email Segment':  segmentCount,
    'Open Rate':              openRate,
  };

  for (const row of rows.slice(1)) {
    const label = (row.table_row.cells[0] ?? []).map(t => t.plain_text).join('').trim();
    if (label in updates) {
      await updateRow(row, currentCol, updates[label]);
      console.log(`  ✓  "${label}" → ${updates[label]}`);
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const required = {
    KLAVIYO_PRIVATE_KEY: KLAVIYO_KEY,
    NOTION_TOKEN:        NOTION_TOKEN,
    NOTION_PAGE_ID:      PAGE_ID,
    KLAVIYO_LIST_ID:     LIST_ID,
    KLAVIYO_SEGMENT_ID:  SEGMENT_ID,
    RECHARGE_API_KEY:    RECHARGE_KEY,
  };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);

  console.log('Fetching Recharge data…');
  const [activeSubscriptions, newThisMonth, churnThisMonth] = await Promise.all([
    getActiveSubscriptionCount(),
    getNewSubscriptionsThisMonth(),
    getCancelledThisMonth(),
  ]);
  console.log(`  Monthly Subscribers:   ${activeSubscriptions.toLocaleString()}`);
  console.log(`  New This Month:        ${newThisMonth.toLocaleString()}`);
  console.log(`  Churn This Month:      ${churnThisMonth.toLocaleString()}`);

  console.log('Fetching Klaviyo data…');
  const [listCount, segmentCount, openRate] = await Promise.all([
    getSegmentCount(LIST_ID),
    getSegmentCount(SEGMENT_ID),
    get30DayOpenRate(),
  ]);
  console.log(`  Email List Size:       ${listCount.toLocaleString()}`);
  console.log(`  Engaged Email Segment: ${segmentCount.toLocaleString()}`);
  console.log(`  30-Day Open Rate:      ${openRate}`);

  console.log('\nUpdating Notion scoreboard…');
  await updateNotion(activeSubscriptions, newThisMonth, churnThisMonth, listCount, segmentCount, openRate);

  console.log('\nDone.');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
