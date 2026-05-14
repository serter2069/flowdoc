import { createRoot } from "react-dom/client";
import { App } from "./App";
import type { FlowDoc } from "../schema";

declare global {
  interface Window {
    __FLOWDOC__?: FlowDoc;
  }
}

function loadData(): FlowDoc {
  const dataNode = document.getElementById("flowdoc-data");
  if (!dataNode || !dataNode.textContent) {
    throw new Error(
      "flowdoc: no data found — the HTML must contain a #flowdoc-data script tag."
    );
  }
  const raw = dataNode.textContent.trim();
  if (raw === "__FLOWDOC_DATA__" || raw === "") {
    throw new Error(
      "flowdoc: this HTML still has the placeholder — render it via `flowdoc build`."
    );
  }
  return JSON.parse(raw) as FlowDoc;
}

const data = loadData();
const root = createRoot(document.getElementById("root")!);
root.render(<App data={data} />);
