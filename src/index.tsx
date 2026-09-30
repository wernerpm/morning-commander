/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { loadSettings } from "./app/settings";

// Panels read their saved path/sort at creation, so settings load first.
void loadSettings().then(() => render(() => <App />, document.getElementById("root") as HTMLElement));
