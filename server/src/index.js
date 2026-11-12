import 'express-async-errors';
import express from 'express';
import http from 'http';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { migrate } from './db.js';
import { authRouter } from './auth.js';
import { apiRouter } from './api.js';
import { attachSockets } from './sockets.js';

await migrate();
const app = express();
app.use(helmet(), cors({ origin: process.env.CLIENT_ORIGIN?.split(',') || true }), express.json({ limit: '100kb' }),
  rateLimit({ windowMs: 60_000, limit: 300 }));
const server = http.createServer(app);
const { io, redis } = await attachSockets(server);

app.get('/health', (_, res) => res.json({ ok: true, instance: process.env.INSTANCE || 'local' }));
app.use('/api/auth', rateLimit({ windowMs: 60_000, limit: 30 }), authRouter);
app.use('/api', apiRouter(redis, io));
app.use((e, _req, res, _next) => {
  console.error(e.message);
  const status = e.status || (e.code === 'LIMIT_FILE_SIZE' ? 413 : e.code?.startsWith('LIMIT_') ? 400 : 500);
  res.status(status).json({ error: status < 500 ? e.message : 'server error' });
});

server.listen(process.env.PORT || 4000, () => console.log(`UTG chat API [${process.env.INSTANCE || 'local'}] up`));
