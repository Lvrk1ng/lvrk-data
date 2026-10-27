// Netlify Function — server-side proxy to the Notion API.
// The browser never sees the Notion integration secret: it lives only
// in this function's environment variables (set in the Netlify dashboard).
//
// Expects a POST body:
// {
//   trade: { date, time, instrument, side, entry, stop, exit, size,
//            dollarPerPoint, risk, pnl, r, setup, emotion, rating,
//            note, chartLink },
//   screenshots: ["data:image/jpeg;base64,...", ...]   // already compressed client-side
// }
//
// Mapped onto the user's actual "Lvrk data" database (their own copy of the
// "P&L Journaling Calendar" template), schema confirmed directly from
// Notion and cleaned up there to match (EOD P&L and Risk are now proper
// Number columns). Quirks that still apply:
//   - The title property is called "Ticker", not "Name".
//   - "Time Entry" is a multi-select of fixed killzone time blocks
//     (e.g. "9:30-9:44", "OUTSIDE KILLZONE"), not freeform text, so an
//     arbitrary trade time can't be written there — it goes in the body
//     instead.
//   - "Outcome" is a select with exactly: WIN, LOSS, BREAK-EVEN, NO TRADES.
//
// Only the columns the app actually has real data for are written:
//   Date, Outcome, EOD P&L, Risk
// Everything else the app tracks (instrument, side, entry/stop/exit, size,
// R multiple, setup, emotion, rating, note, chart link, time) has no usable
// column in this template, so it goes into the page body instead — a
// summary paragraph plus the screenshot images — rather than inventing new
// columns and breaking "the same framework".
//
// The title property's actual name is resolved from the database schema
// rather than hardcoded, since it's user-renameable (confirmed "Ticker" for
// this workspace, but this keeps it correct even if renamed again).
//
// NOTION_VERSION below is recent enough that Notion's "data sources" model
// applies (a database can hold more than one data source; pages belong to
// a data source, not directly to the database). So NOTION_DATABASE_ID here
// must be the data source ID, not the database's own page ID — for this
// workspace's single-source database that's the ID copied from the
// database's "Copy link to view" URL.

// File Upload API needs a recent version — the 2022 version predates it.
const NOTION_VERSION = '2026-03-11';
const NOTION_API = 'https://api.notion.com/v1';

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function notionHeaders(secret, extra = {}) {
  return {
    'Authorization': `Bearer ${secret}`,
    'Notion-Version': NOTION_VERSION,
    ...extra,
  };
}

function dataUrlToBuffer(dataUrl) {
  const match = /^data:(.+?);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  const [, mime, base64] = match;
  return { mime, buffer: Buffer.from(base64, 'base64') };
}

// Finds the name of the database's title property (the one that fills the
// page heading). It's almost always called "Name", but Notion lets anyone
// rename it, so this reads it from the schema instead of assuming.
async function getTitlePropertyName(secret, dataSourceId) {
  try {
    const res = await fetch(`${NOTION_API}/data_sources/${dataSourceId}`, {
      headers: notionHeaders(secret),
    });
    if (!res.ok) return 'Name';
    const db = await res.json();
    const entry = Object.entries(db.properties || {}).find(([, v]) => v.type === 'title');
    return entry ? entry[0] : 'Name';
  } catch {
    return 'Name';
  }
}

// Uploads one image to Notion via the File Upload API (create -> send),
// then returns the file_upload id to attach to a block or property.
async function uploadImageToNotion(secret, dataUrl, filename) {
  const parsed = dataUrlToBuffer(dataUrl);
  if (!parsed) throw new Error('Invalid screenshot data URL');

  // Step 1: create a file upload placeholder
  const createRes = await fetch(`${NOTION_API}/file_uploads`, {
    method: 'POST',
    headers: notionHeaders(secret, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ filename, content_type: parsed.mime }),
  });
  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`File upload create failed (${createRes.status}): ${errText}`);
  }
  const created = await createRes.json();

  // Step 2: send the binary content. POST to the documented send endpoint
  // (not the `upload_url` field — using the fixed path avoids relying on
  // response shape that could change).
  const form = new FormData();
  form.append('file', new Blob([parsed.buffer], { type: parsed.mime }), filename);

  const sendRes = await fetch(`${NOTION_API}/file_uploads/${created.id}/send`, {
    method: 'POST',
    headers: notionHeaders(secret), // do not set Content-Type — fetch sets the multipart boundary
    body: form,
  });
  if (!sendRes.ok) {
    const errText = await sendRes.text();
    throw new Error(`File upload send failed (${sendRes.status}): ${errText}`);
  }

  return created.id;
}

exports.handler = async (event) => {
  const secret = process.env.NOTION_SECRET;
  const databaseId = process.env.NOTION_DATABASE_ID;

  // Lightweight health check — does not call Notion, just confirms the
  // function is deployed and the env vars are set.
  if (event.httpMethod === 'GET') {
    if (!secret || !databaseId) {
      return json(200, { ok: false, reason: 'Missing NOTION_SECRET or NOTION_DATABASE_ID env vars in Netlify' });
    }
    // Confirm the integration token and data source are actually reachable.
    try {
      const res = await fetch(`${NOTION_API}/data_sources/${databaseId}`, {
        headers: notionHeaders(secret),
      });
      if (!res.ok) {
        const errText = await res.text();
        return json(200, { ok: false, reason: `Notion rejected the database lookup (${res.status}): ${errText}` });
      }
      return json(200, { ok: true });
    } catch (err) {
      return json(200, { ok: false, reason: err.message });
    }
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  if (!secret || !databaseId) {
    return json(500, { error: 'Server is not configured — missing NOTION_SECRET or NOTION_DATABASE_ID env vars' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { trade, screenshots = [] } = payload;
  if (!trade || !trade.instrument || !trade.entry || !trade.stop) {
    return json(400, { error: 'Missing required trade fields' });
  }

  try {
    // 1. Upload each screenshot (if any) to get Notion file_upload ids.
    const fileUploadIds = [];
    for (let i = 0; i < screenshots.length; i++) {
      const ext = screenshots[i].includes('image/png') ? 'png' : 'jpg';
      const filename = `${(trade.id || 'trade').slice(0, 8)}-${i + 1}.${ext}`;
      const id = await uploadImageToNotion(secret, screenshots[i], filename);
      fileUploadIds.push(id);
    }

    // 2. Resolve the title property's real name, then build the page
    //    properties — only the columns this template actually has.
    const titleKey = await getTitlePropertyName(secret, databaseId);
    const title = `${trade.instrument}${trade.side ? ' ' + trade.side : ''}`;
    const outcome = trade.pnl == null ? undefined
      : trade.pnl > 0 ? 'WIN'
      : trade.pnl < 0 ? 'LOSS'
      : 'BREAK-EVEN';

    const properties = {
      [titleKey]: { title: [{ text: { content: title } }] },
      'Date': trade.date ? { date: { start: trade.date } } : undefined,
      'Outcome': outcome ? { select: { name: outcome } } : undefined,
      'EOD P&L': trade.pnl != null ? { number: trade.pnl } : undefined,
      'Risk': trade.risk != null ? { number: trade.risk } : undefined,
    };
    // Strip undefined keys (Notion rejects them).
    Object.keys(properties).forEach((k) => properties[k] === undefined && delete properties[k]);

    // 3. Build page body blocks: a summary paragraph for everything this
    //    template has no column for (instrument/side/entry/stop/exit/size/
    //    R multiple/setup/emotion/rating/note/chart link), then an image
    //    block per screenshot.
    const summaryLines = [
      `${trade.instrument} ${trade.side || ''}`.trim(),
      trade.time ? `Time: ${trade.time}` : null,
      trade.entry != null ? `Entry: ${trade.entry}` : null,
      trade.stop != null ? `Stop: ${trade.stop}` : null,
      trade.exit != null ? `Exit: ${trade.exit}` : null,
      trade.size != null ? `Size: ${trade.size}` : null,
      trade.r != null && isFinite(trade.r) ? `R multiple: ${trade.r.toFixed(2)}R` : null,
      trade.setup ? `Setup: ${trade.setup}` : null,
      trade.emotion ? `Emotion: ${trade.emotion}` : null,
      trade.rating != null ? `Rating: ${trade.rating}/5` : null,
      trade.chartLink ? `Chart: ${trade.chartLink}` : null,
      trade.note ? `Note: ${trade.note}` : null,
    ].filter(Boolean).join('\n');

    const children = [
      {
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ text: { content: summaryLines.slice(0, 2000) } }] },
      },
      ...fileUploadIds.map((id) => ({
        object: 'block',
        type: 'image',
        image: { type: 'file_upload', file_upload: { id } },
      })),
    ];

    // 4. Create the page in the database. The first screenshot (if any) is
    //    also set as the page cover, so gallery views in Notion show the
    //    chart image first, with the trade's properties underneath.
    const pageBody = {
      parent: { type: 'data_source_id', data_source_id: databaseId },
      properties,
      children,
    };
    if (fileUploadIds.length > 0) {
      pageBody.cover = { type: 'file_upload', file_upload: { id: fileUploadIds[0] } };
    }

    const pageRes = await fetch(`${NOTION_API}/pages`, {
      method: 'POST',
      headers: notionHeaders(secret, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(pageBody),
    });

    if (!pageRes.ok) {
      const errText = await pageRes.text();
      return json(pageRes.status, { error: `Notion page creation failed: ${errText}` });
    }

    const page = await pageRes.json();
    return json(200, { ok: true, pageId: page.id, url: page.url });
  } catch (err) {
    return json(500, { error: err.message || 'Unknown error pushing to Notion' });
  }
};
