import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3100);
createServer((req, res) => {
  if (req.url === "/health") return void res.end("ok");
  res.end(`${process.env.GREETING ?? "hello"} from freighter\n`);
}).listen(port, "127.0.0.1", () => console.log(`listening on ${port}`));
