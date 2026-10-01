const PROMPT = `You are a nutrition expert for Indian food (roti, dal, sabzi, rice, biryani, dosa, idli, paneer, street food, sweets).
Look at the photo. Identify each food item, estimate the portion in Indian household units (1 katori, 2 rotis, 1 plate), and estimate nutrition.
If there is no food in the photo, set "food" to false.
Reply with ONLY JSON in this shape:
{"food":true,"meal":"short name","items":[{"name":"","portion":"","kcal":0}],"total":{"kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0},"tip":"one short healthy tip"}`;

const hits = new Map();
const LIMIT_PER_HOUR = 20;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Missing GEMINI_API_KEY in Vercel settings' });
  }

  const ip = (req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
  const hour = Math.floor(Date.now() / 3600000);
  const key = ip + ':' + hour;
  const n = (hits.get(key) || 0) + 1;
  hits.set(key, n);
  if (n > LIMIT_PER_HOUR) return res.status(429).json({ error: 'Too many scans. Try later.' });

  const { image } = req.body || {};
  if (!image || image.length > 4000000) return res.status(400).json({ error: 'Bad image' });

  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: PROMPT },
            { inline_data: { mime_type: 'image/jpeg', data: image } }
          ]}],
          generationConfig: { responseMimeType: 'application/json' }
        })
      }
    );
    const data = await r.json();
    if (!r.ok) {
      return res.status(502).json({ error: 'AI error: ' + (data?.error?.message || r.status) });
    }
    const parts = data.candidates?.[0]?.content?.parts || [];
    let text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('');
    text = text.replace(/```json|```/g, '').trim();
    if (!text) return res.status(502).json({ error: 'AI returned nothing' });
    return res.status(200).json(JSON.parse(text));
  } catch (e) {
    return res.status(500).json({ error: 'Server error: ' + e.message });
  }
      }
      
