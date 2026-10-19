import { createDb, seedDb } from './db.ts';
import { createApp } from './app.ts';

const db = createDb('./newtonite.sqlite');
seedDb(db);
const { app, processOutboxBatch } = createApp(db);

setInterval(() => {
  processOutboxBatch(false);
}, 3000);

const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Newtonite Ops Server running on http://127.0.0.1:${PORT}`);
});