/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { loadSettings } from "./app/settings";

// Panels read their saved path/sort from state.json, so load it first.
void loadSettings().finally(() => render(() => <App />, document.getElementById("root") as HTMLElement));
