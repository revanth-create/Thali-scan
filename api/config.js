export default function handler(req, res) {
  res.status(200).json({
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_PUBLISHABLE_KEY
  });
}
