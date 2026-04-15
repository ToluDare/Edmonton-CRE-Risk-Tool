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
  const { lat, lon, address, messages, model, max_tokens } = body;

  const [edmData, renxData, newsData] = await Promise.allSettled([
    fetchEdmontonData(lat, lon),
    fetchRENX(),
    fetchGoogleNews(address)
  ]);

  const edm  = edmData.status  === 'fulfilled' ? edmData.value  : null;
  const renx = renxData.status === 'fulfilled' ? renxData.value : null;
  const news = newsData.status === 'fulfilled' ? newsData.value : null;

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
    liveContext += '\nCity of Edmonton property data: unavailable for this location.\n';
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
  liveContext += '\nIMPORTANT: Use the live data above to make your analysis specific, current, and differentiated per property. Never give generic responses.';

  const enrichedMessages = messages.map((msg, idx) => {
    if (idx === 0 && msg.role === 'user') {
      return { ...msg, content: msg.content + liveContext };
    }
    return msg;
  });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model, max_tokens, messages: enrichedMessages })
  });

  const data = await response.json();

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

async function fetchEdmontonData(lat, lon) {
  try {
    const url = `https://data.edmonton.ca/resource/q7d6-ambg.json?$where=latitude between ${lat - 0.002} and ${lat + 0.002} and longitude between ${lon - 0.003} and ${lon + 0.003}&$limit=1`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data || data.length === 0) return null;
    const rec = data[0];
    return {
      assessedValue: rec.assessed_value
        ? `$${parseInt(rec.assessed_value).toLocaleString('en-CA')}`
        : rec.assessment_value
        ? `$${parseInt(rec.assessment_value).toLocaleString('en-CA')}`
        : null,
      zoning: rec.zoning || rec.zone || null,
      landUse: rec.land_use_description || rec.property_use || null,
      neighbourhood: rec.neighbourhood_name || rec.neighbourhood || null,
      lotSize: rec.lot_size ? `${rec.lot_size} m²` : null,
    };
  } catch (e) {
    return null;
  }
}

async function fetchRENX() {
  try {
    const r = await fetch(
      'https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Frenx.ca%2Ffeed&count=10',
      { headers: { 'Accept': 'application/json' } }
    );
    if (!r.ok) return [];
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

async function fetchGoogleNews(address) {
  try {
    const q = encodeURIComponent(`Edmonton commercial real estate ${(address||'').split(',')[0]}`);
    const r = await fetch(
      `https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fnews.google.com%2Frss%2Fsearch%3Fq%3D${q}%26hl%3Den-CA%26gl%3DCA%26ceid%3DCA%3Aen&count=6`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!r.ok) return [];
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
