export const config = { runtime: 'edge' };

export default async function handler(req) {

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }

  const body = await req.json();
  const { lat, lon, address, messages } = body;

  // ── FETCH LIVE DATA IN PARALLEL ──────────────────────────
  const [edmData, renxData, newsData] = await Promise.allSettled([
    fetchEdmontonData(lat, lon, address),
    fetchRENX(),
    fetchGoogleNews(address)
  ]);

  const edm  = edmData.status  === 'fulfilled' ? edmData.value  : null;
  const renx = renxData.status === 'fulfilled' ? renxData.value : null;
  const news = newsData.status === 'fulfilled' ? newsData.value : null;

  // ── BUILD CONTEXT STRING ──────────────────────────────────
  let liveContext = '\n\n--- LIVE MARKET DATA (ground your analysis in this) ---\n';

  if (edm) {
    liveContext += `
CITY OF EDMONTON OPEN DATA:
- Assessed Value: ${edm.assessedValue || 'Not found'}
- Zoning: ${edm.zoning || 'Not found'}
- Land Use: ${edm.landUse || 'Not found'}
- Neighbourhood: ${edm.neighbourhood || 'Not found'}
- Lot Size: ${edm.lotSize || 'Not found'}
`;
  } else {
    liveContext += '\nCity of Edmonton property data: unavailable for this exact location.\n';
  }

  if (renx && renx.length > 0) {
    liveContext += `
LATEST EDMONTON CRE NEWS (RENX.ca):
${renx.slice(0, 5).map((item, i) => `${i + 1}. ${item.title} (${item.date})`).join('\n')}
`;
  }

  if (news && news.length > 0) {
    liveContext += `
LOCAL NEWS FOR THIS AREA:
${news.slice(0, 4).map((item, i) => `${i + 1}. ${item.title}`).join('\n')}
`;
  }

  liveContext += '\n--- END LIVE DATA ---\n';
  liveContext += '\nIMPORTANT: Use the live data above to make your analysis specific and current. Do not give generic responses.';

  // ── INJECT CONTEXT INTO PROMPT ────────────────────────────
  const enrichedMessages = messages.map((msg, idx) => {
    if (idx === 0 && msg.role === 'user') {
      return { ...msg, content: msg.content + liveContext };
    }
    return msg;
  });

  // ── CALL CLAUDE ───────────────────────────────────────────
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: body.model,
      max_tokens: body.max_tokens,
      messages: enrichedMessages
    })
  });

  const data = await response.json();

  // Attach live data so frontend can show it
  if (data.content) {
    data._live = {
      edmonton: edm,
      renx: renx?.slice(0, 3) || [],
      news: news?.slice(0, 3) || []
    };
  }

  return new Response(JSON.stringify(data), {
    status: response.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    }
  });
}

// ── CITY OF EDMONTON OPEN DATA ────────────────────────────
async function fetchEdmontonData(lat, lon, address) {
  try {
    const url = `https://data.edmonton.ca/resource/q7d6-ambg.json?$where=latitude between ${lat - 0.002} and ${lat + 0.002} and longitude between ${lon - 0.003} and ${lon + 0.003}&$limit=1`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('Edmonton API error');
    const data = await r.json();
    if (!data || data.length === 0) return null;
    return parseEdmontonRecord(data[0]);
  } catch (e) {
    return null;
  }
}

function parseEdmontonRecord(r) {
  return {
    assessedValue: r.assessed_value
      ? `$${parseInt(r.assessed_value).toLocaleString('en-CA')}`
      : r.assessment_value
      ? `$${parseInt(r.assessment_value).toLocaleString('en-CA')}`
      : null,
    zoning: r.zoning || r.zone || null,
    landUse: r.land_use_description || r.property_use || null,
    neighbourhood: r.neighbourhood_name || r.neighbourhood || null,
    lotSize: r.lot_size ? `${r.lot_size} m²` : null,
  };
}

// ── RENX.CA RSS ───────────────────────────────────────────
async function fetchRENX() {
  try {
    const r = await fetch(
      'https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Frenx.ca%2Ffeed&count=10',
      { headers: { 'Accept': 'application/json' } }
    );
    if (!r.ok) throw new Error('RENX failed');
    const data = await r.json();
    if (!data.items) return [];
    return data.items
      .filter(item =>
        /edmonton|alberta|commercial|office|retail|industrial|multifamily|cap rate|vacancy/i
        .test(item.title + ' ' + (item.description || ''))
      )
      .map(item => ({
        title: item.title,
        date: new Date(item.pubDate).toLocaleDateString('en-CA'),
      }));
  } catch (e) {
    return [];
  }
}

// ── GOOGLE NEWS RSS ───────────────────────────────────────
async function fetchGoogleNews(address) {
  try {
    const q = encodeURIComponent(`Edmonton commercial real estate ${address.split(',')[0]}`);
    const r = await fetch(
      `https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fnews.google.com%2Frss%2Fsearch%3Fq%3D${q}%26hl%3Den-CA%26gl%3DCA%26ceid%3DCA%3Aen&count=6`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!r.ok) throw new Error('News failed');
    const data = await r.json();
    if (!data.items) return [];
    return data.items.slice(0, 5).map(item => ({
      title: item.title.replace(/\s*-\s*[^-]*$/, ''),
      date: new Date(item.pubDate).toLocaleDateString('en-CA'),
    }));
  } catch (e) {
    return [];
  }
}
