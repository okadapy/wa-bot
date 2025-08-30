const crypto = require('crypto');

module.exports = function verifySchedulerSignature(req, res, next) {
  try {
    const sigHeader = process.env.SCHEDULER_SIGNATURE_HEADER || 'X-Scheduler-Signature';
    const tsHeader  = process.env.SCHEDULER_TIMESTAMP_HEADER || 'X-Scheduler-Timestamp';
    const secret    = process.env.SCHEDULER_HMAC_SECRET;

    if (!secret) return res.status(500).json({ error: 'Missing HMAC secret' });

    const signature = req.get(sigHeader);
    const timestamp = req.get(tsHeader);
    if (!signature || !timestamp) return res.status(401).json({ error: 'Missing signature headers' });

    const now = Math.floor(Date.now() / 1000);
    const windowSec = Number(process.env.SCHEDULER_TIMESTAMP_WINDOW_SEC || 600);
    if (Math.abs(now - Number(timestamp)) > windowSec) {
      return res.status(401).json({ error: 'Stale or future timestamp' });
    }

    const raw = (req.rawBody ? req.rawBody : (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body || {})));
    const hmac = crypto.createHmac('sha256', secret).update(timestamp + '.' + raw).digest('hex');

    const a = Buffer.from(hmac);
    const b = Buffer.from(signature);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    return next();
  } catch (e) {
    console.error('verifySchedulerSignature error', e);
    return res.status(401).json({ error: 'Signature check failed' });
  }
};
