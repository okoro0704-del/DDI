import { pathToFileURL } from "node:url";
import { composeRuntime } from "./compose.ts";

const runtime = await composeRuntime(process.env);
const port = Number(process.env.PORT ?? 8080);
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runtime.app.listen({ port, host: "127.0.0.1" });
}
