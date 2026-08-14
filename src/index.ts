import { createHttpServer } from './server/app.js';

const port = Number(process.env.PORT ?? 3000);
const server = createHttpServer();

server.listen(port, () => {
  // eslint-disable-next-line no-console -- startup log is expected operational output.
  console.log(`request-service listening on http://localhost:${port}`);
});
