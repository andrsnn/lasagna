import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ready } from "./sdk";

// Wait for the host handshake (state/params hydrated) before first paint so
// artifact.state reads in App return real data.
ready().finally(() => {
  const el = document.getElementById("root");
  if (el) createRoot(el).render(<App />);
});
