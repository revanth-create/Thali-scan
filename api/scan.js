export const config = { maxDuration: 60 };

const BASE = `You are a nutrition expert for Indian food (roti, dal, sabzi, rice dishes, biryani, dosa, idli, paneer, street food, sweets).
Look at the photo. Identify each food item, estimate the portion in Indian household units (1 katori, 2 rotis, 1 plate), and estimate nutrition.
Rice dishes look alike (masala rice, capsicum rice, vegetable rice, tomato rice, lemon rice), so pick the most likely one and give a similar alternative in "alt".
Set "confidence" to "high", "medium" or "low".
If there is no food in the photo, set "food" to false.
Reply with ONLY JSON in this shape:
{"food":true,"meal":"short name","alt":"similar dish it could be, or empty","confidence":"medium","items":[{"name":"","portion":"","kcal":0}],"total":{"kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0},"tip":"one short healthy tip"}`;

const FREE_LIMIT = parseInt(process.env.FREE_LIMIT || '3', 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ask(model, prompt, image) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 18000);
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: prompt },
            { inline_data: { mime_type: 'image/jpeg', data: image } }
          ]}],
          generationConfig: { responseMimeType: 'application/json' }
        })
      }
    );
    const data = await r.json();
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: { message: e.name === 'AbortError' ? 'AI took too long' : e.message } } };
  } finally {
    clearTimeout(timer);
  }
}

function parseResult(data) {
  const parts = data.candidates?.[0]?.content?.parts || [];
  let text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('');
  text = text.replace(/```json|```/g, '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

async function getUser(token) {
  const r = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + token }
  });
  if (!r.ok) return null;
  return r.json();
}

async function useScan(userId) {
  const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/rpc/use_scan', {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ p_user: userId, p_limit: FREE_LIMIT })
  });
  if (!r.ok) return null;
  return r.json();
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    if (!process.env.GEMINI_API_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: 'Server settings are missing in Vercel' });
    }

    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Please log in first' });
    const user = await getUser(token);
    if (!user || !user.id) return res.status(401).json({ error: 'Please log in again' });

    const { image, correction } = req.body || {};
    if (!image || image.length > 4000000) return res.status(400).json({ error: 'Bad image' });

    const used = await useScan(user.id);
    if (used === null) return res.status(500).json({ error: 'Could not check your scan limit' });
    if (used === -1) {
      return res.status(429).json({ error: 'You have used your ' + FREE_LIMIT + ' free scans for today. Come back tomorrow!', limit: true });
    }

    let prompt = BASE;
    if (correction) {
      const c = String(correction).slice(0, 100);
      prompt += `\n\nIMPORTANT: The user says this meal is: "${c}". Treat that as the correct dish and portion, and calculate nutrition for it. Set confidence to "high" and alt to "".`;
    }

    const models = [process.env.GEMINI_MODEL || 'gemini-3.8-flash', 'gemini-3.5-flash'];
    let lastError = 'Unknown error';

    for (let m = 0; m < models.length; m++) {
      const tries = m === 0 ? 2 : 1;
      for (let attempt = 0; attempt < tries; attempt++) {
        const { ok, status, data } = await ask(models[m], prompt, image);
        if (ok) {
          const result = parseResult(data);
          if (result) {
            result.left = Math.max(0, FREE_LIMIT - used);
            return res.status(200).json(result);
          }
          lastError = 'AI reply was not readable';
          break;
        }
        lastError = data?.error?.message || String(status);
        if (![429, 500, 503].includes(status)) break;
        await sleep(1200);
      }
    }
    return res.status(502).json({ error: 'AI is busy, please try again in a minute. (' + lastError + ')' });
  } catch (e) {
    return res.status(500).json({ error: 'Server error: ' + e.message });
  }
        }
