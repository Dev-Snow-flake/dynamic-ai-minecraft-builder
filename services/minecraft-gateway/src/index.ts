import { createGateway } from "./server.js";

const port = Number(process.env.GATEWAY_PORT ?? 8787);
const host = process.env.GATEWAY_HOST ?? "127.0.0.1";
const gateway = createGateway();

gateway.httpServer.listen(port, host, () => {
  console.log(`Dynamic AI Gateway ready at http://${host}:${port}`);
  console.log(`Browser event stream: ws://${host}:${port}/events`);
});

const shutdown = async () => {
  await gateway.close();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
