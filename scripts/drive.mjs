// Drive the real app (WKWebView) through tauri-plugin-webdriver.
// Start the app with:  pnpm tauri dev --features webdriver
// Then:                node scripts/drive.mjs <step> [<step> ...]
//
// Steps:
//   key:Enter  key:Meta+r  key:F7     press a key chord (W3C key actions)
//   type:hello                        type text (note: appends; doesn't replace a selection)
//   fill:/some/path                   set the focused input's value (use for dialogs)
//   wait:500                          sleep milliseconds
//   eval:<js>                         run JS in the page, print the JSON result
//   shot:out.png                      save a screenshot of the webview
//   state                             print both panels' path, cursor and row count
//
// Uses only Node built-ins so it runs anywhere (including Claude Cloud).

import { writeFileSync } from "node:fs";

const BASE = `http://127.0.0.1:${process.env.TAURI_WEBDRIVER_PORT ?? 4445}`;

const KEYS = {
  Enter: "", Tab: "", Escape: "", Backspace: "", Space: "",
  ArrowUp: "", ArrowDown: "", ArrowLeft: "", ArrowRight: "",
  PageUp: "", PageDown: "", Home: "", End: "", Delete: "", Insert: "",
  Shift: "", Control: "", Alt: "", Meta: "",
  F1: "", F2: "", F3: "", F4: "", F5: "", F6: "",
  F7: "", F8: "", F9: "", F10: "", F11: "", F12: "",
};

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.value?.error) throw new Error(`${method} ${path}: ${JSON.stringify(json.value ?? json)}`);
  return json.value;
}

const session = (await call("POST", "/session", { capabilities: {} })).sessionId;
const s = (p) => `/session/${session}${p}`;

async function keys(values) {
  const actions = [];
  for (const v of values) actions.push({ type: "keyDown", value: v });
  for (const v of [...values].reverse()) actions.push({ type: "keyUp", value: v });
  await call("POST", s("/actions"), { actions: [{ type: "key", id: "kb", actions }] });
}

async function chord(spec) {
  const parts = spec.split("+");
  await keys(parts.map((p) => KEYS[p] ?? p));
}

const evalJs = (script) => call("POST", s("/execute/sync"), { script, args: [] });

const STATE_JS = `return [0, 1].map((id) => {
  const p = document.querySelector('[data-panel="' + id + '"]');
  return {
    path: p?.querySelector('.panel-path')?.textContent,
    cursor: p?.querySelector('.row.cursor')?.dataset.name,
    active: p?.classList.contains('active'),
    status: p?.querySelector('.panel-status')?.textContent,
  };
});`;

try {
  for (const step of process.argv.slice(2)) {
    const [cmd, ...rest] = step.split(":");
    const arg = rest.join(":");
    if (cmd === "key") await chord(arg);
    else if (cmd === "type") for (const ch of arg) await keys([ch]);
    else if (cmd === "fill")
      await evalJs(
        `const el = document.activeElement; el.value = ${JSON.stringify(arg)}; el.dispatchEvent(new Event("input", { bubbles: true })); return el.value;`,
      );
    else if (cmd === "wait") await new Promise((r) => setTimeout(r, Number(arg)));
    else if (cmd === "eval") console.log(JSON.stringify(await evalJs(arg), null, 2));
    else if (cmd === "state") console.log(JSON.stringify(await evalJs(STATE_JS), null, 2));
    else if (cmd === "shot") {
      writeFileSync(arg, Buffer.from(await call("GET", s("/screenshot")), "base64"));
      console.log(`saved ${arg}`);
    } else throw new Error(`unknown step: ${step}`);
  }
} finally {
  await call("DELETE", s("")).catch(() => {});
}
