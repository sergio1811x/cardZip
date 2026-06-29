import 'dotenv/config';
import express from 'express';
import webhookHandler from '../api/webhook';
import step1Handler from '../api/step1-elim';
import step2Handler from '../api/step2-ai';
import step3Handler from '../api/step3-market';
import step4Handler from '../api/step4-send';
import step5Handler from '../api/step5-qa';
import step6Handler from '../api/step6-send';
import updateWbCategoriesHandler from '../api/update-wb-categories';

const PORT = parseInt(process.env.BOT_PORT || process.env.PORT || '8080', 10);

const app = express();
app.use(express.json({ limit: '2mb' }));

function wrap(handler: any) {
  return (req: express.Request, res: express.Response) => {
    Promise.resolve(handler(req as any, res as any)).catch((error: any) => {
      console.error('[server] Route error:', error?.message ?? error);
      if (!res.headersSent) res.status(200).json({ ok: false, error: error?.message ?? 'route_error' });
    });
  };
}

// One code path for VPS and Vercel-style deploys. The old VPS server only had /webhook,
// so /api/stepN fetches could return 404 while the loader kept spinning.
app.post('/webhook', wrap(webhookHandler));
app.post('/api/webhook', wrap(webhookHandler));
app.post('/api/step1-elim', wrap(step1Handler));
app.post('/api/step2-ai', wrap(step2Handler));
app.post('/api/step3-market', wrap(step3Handler));
app.post('/api/step4-send', wrap(step4Handler));
app.post('/api/step5-qa', wrap(step5Handler));
app.post('/api/step6-send', wrap(step6Handler));
app.post('/api/update-wb-categories', wrap(updateWbCategoriesHandler));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`CardZip VPS server (HTTP) running on port ${PORT}`);
});
