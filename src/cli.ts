import { Command } from "commander";
import { buildCommand } from "./commands/build.js";
import { initCommand } from "./commands/init.js";
import { serveCommand } from "./commands/serve.js";

const program = new Command();

program
  .name("flowdoc")
  .description(
    "Document workflows between packages/components as a clickable, animated diagram driven by JSON."
  )
  .version("0.1.0");

program
  .command("init")
  .description("Create a starter flows.json in the current directory")
  .option("-o, --out <path>", "Output path", "flows.json")
  .option("--force", "Overwrite an existing file", false)
  .action(initCommand);

program
  .command("build")
  .description("Render a flows.json to a single self-contained HTML file")
  .argument("[flows]", "Path to flows.json", "flows.json")
  .option("-o, --out <path>", "Output HTML path", "flowdoc.html")
  .action(buildCommand);

program
  .command("serve")
  .description(
    "Serve a flows.json with live reload — rebuild + browser refresh on changes"
  )
  .argument("[flows]", "Path to flows.json", "flows.json")
  .option("-p, --port <port>", "Port to listen on", "4173")
  .action(serveCommand);

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
