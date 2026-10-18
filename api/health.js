module.exports = (req, res) => {
  res.status(200).json({
    status: 'ok',
    platform: 'Vercel Serverless',
    timestamp: new Date().toISOString(),
    service: 'PulseChat with Supabase Realtime'
  });
};
