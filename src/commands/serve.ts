import { watch } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { renderHtml } from "./build.js";

export function serveCommand(flowsArg: string, opts: { port: string }) {
  const flowsPath = resolve(process.cwd(), flowsArg ?? "flows.json");
  const port = Number(opts.port);
  if (Number.isNaN(port)) {
    throw new Error(`Invalid port: ${opts.port}`);
  }

  let cachedHtml = renderHtml(flowsPath);
  let revision = Date.now();

  const refresh = () => {
    try {
      cachedHtml = renderHtml(flowsPath);
      revision = Date.now();
      console.log(`↻ reloaded ${flowsArg} @ ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : err}`);
    }
  };

  watch(flowsPath, { persistent: true }, refresh);

  const server = createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end();
      return;
    }
    if (req.url.startsWith("/__revision")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ revision }));
      return;
    }
    const liveReloadShim = `<script>
(function(){
  var current = ${revision};
  setInterval(function(){
    fetch('/__revision').then(function(r){return r.json();}).then(function(d){
      if (d.revision !== current) { window.location.reload(); }
    }).catch(function(){});
  }, 800);
})();
</script>`;
    const body = cachedHtml.replace("</body>", liveReloadShim + "</body>");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(body);
  });

  server.listen(port, () => {
    console.log(`flowdoc serving ${flowsArg} → http://localhost:${port}`);
    console.log(`(edits to ${flowsArg} live-reload the browser)`);
  });
}
