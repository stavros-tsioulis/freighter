import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3100);
const read = (f) => {
  try {
    return readFileSync(new URL(f, import.meta.url), "utf8").trim();
  } catch {
    return "(missing)";
  }
};

createServer((req, res) => {
  if (req.url === "/health") return void res.end("ok");
  res.end(`${read("message.txt")} [${read("BUILT")}]\n`);
}).listen(port, "127.0.0.1", () => console.log(`listening on ${port}`));
