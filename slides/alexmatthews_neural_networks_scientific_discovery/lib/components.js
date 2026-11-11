// cslides components: <cs-plot>, <cs-structure>, <cs-molecule>, <cs-table>, <cs-embed> (spec section 4, CONTRACTS.md
// "Components").
// A classic script, not a module, so it also runs from file:// in a downloaded deck.
//
// Every element renders into an open shadow root and never changes its light DOM (attributes included), so the
// slide source the editor parses and saves stays exactly what the author wrote. Data comes from `src`, looked up
// first in window.cslidesAssets (the download inlines it), else fetched relative to document.baseURI, or from a
// child <script type="application/json">. The child is read by tag only: in edit mode frame.js changes script
// types while it holds them back.
//
// Readiness: <html data-cs-pending> counts elements still rendering; each element dispatches a bubbling
// "cs-ready" event ({detail: {ok, error}}) when it has rendered or failed; window.cslidesReady() resolves once
// the document is parsed and the count is 0.
(() => {
  let pending = 0;
  let waiters = [];
  const setPending = (delta) => {
    pending += delta;
    document.documentElement.dataset.csPending = String(pending);
    if (pending === 0 && document.readyState !== "loading") {
      waiters.forEach((resolve) => resolve());
      waiters = [];
    }
  };
  setPending(0);

  const parsed = new Promise((resolve) => {
    if (document.readyState !== "loading") resolve();
    else document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
  });
  window.cslidesReady = () =>
    parsed.then(() => new Promise((resolve) => (pending === 0 ? resolve() : waiters.push(resolve))));

  // Shared helpers.

  const waitFor = (name, timeout = 15000) =>
    new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window[name]) resolve(window[name]);
        else if (Date.now() - start > timeout) reject(new Error(`${name} did not load`));
        else setTimeout(check, 50);
      };
      check();
    });

  const loadText = async (src) => {
    const inline = window.cslidesAssets;
    if (inline && Object.prototype.hasOwnProperty.call(inline, src)) return inline[src];
    const response = await fetch(new URL(src, document.baseURI));
    if (!response.ok) throw new Error(`${src}: HTTP ${response.status}`);
    return response.text();
  };

  const childJSON = (el) => {
    const script = el.querySelector(":scope > script");
    return script ? JSON.parse(script.textContent) : null;
  };

  const HOST_CSS = ":host { display: block; position: relative; } .fill { position: absolute; inset: 0; }"
    + " .error { font: 24px var(--cs-mono, monospace); color: #b3261e; padding: 16px; }";

  const REMOVED = new Error("removed from the document");

  // Base class: one render per element, started once the document is parsed (children exist by then). An element
  // removed from the document (a slide swapped out in the editor) stops rendering, calls its `release()`, which
  // lets go of what it holds (WebGL contexts: Chrome keeps about 16 per page), and stops watching its size; put
  // back, it renders again.
  class Component extends HTMLElement {
    connectedCallback() {
      if (this.csStarted) return;
      this.csStarted = true;
      const root = this.shadowRoot || this.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${HOST_CSS}${this.constructor.css || ""}</style>`;
      setPending(1);
      const removed = new Promise((_, reject) => (this.csRemoved = reject));
      Promise.race([parsed.then(() => this.render(root)), removed])
        .then(() => ({ ok: true, error: null }), (error) => {
          if (error === REMOVED) return { ok: false, error: error.message };
          console.error(`<${this.localName}>`, error);
          const box = document.createElement("div");
          box.className = "error";
          box.textContent = `${this.localName}: ${error.message || error}`;
          root.append(box);
          return { ok: false, error: String(error.message || error) };
        })
        .then((detail) => {
          this.csState = detail.ok ? "ready" : "error";
          this.dispatchEvent(new CustomEvent("cs-ready", { bubbles: true, composed: true, detail }));
          setPending(-1);
        });
    }

    disconnectedCallback() {
      // a move (removed and inserted in one task) keeps the element as it is
      queueMicrotask(() => {
        if (this.isConnected || !this.csStarted) return;
        this.csStarted = false;
        this.csRemoved(REMOVED);
        this.release?.();
        for (const observer of this.csObservers || []) observer.disconnect();
        this.csObservers = [];
      });
    }

    // Calls back after the element's box changes size (a resize handle dragged in the editor, a window
    // resized), at most once per frame however many changes arrive in between.
    observeSize(callback) {
      let first = true;
      let frame = 0;
      const observer = new ResizeObserver(() => {
        if (first) return (first = false);
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(callback);
      });
      observer.observe(this);
      (this.csObservers ||= []).push(observer);
    }
  }

  // <cs-plot>: a Plotly figure {data, layout?, config?}. It re-lays-out whenever its box changes size, and
  // `el.react(figure)` redraws it with a new figure (a slide script driving the plot from a slider).
  // Plotly writes its stylesheet into document.head, which a shadow root does not see; the rules are copied in.
  class CsPlot extends Component {
    layoutFor(figure) {
      const style = getComputedStyle(this);
      return {
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
        ...figure.layout,
        font: { family: style.fontFamily, color: style.color, ...(figure.layout || {}).font },
        autosize: true,
      };
    }

    react(figure) {
      if (!this.plot) throw new Error("<cs-plot> has not rendered yet: wait for cs-ready or cslidesReady()");
      const config = { displaylogo: false, ...figure.config, responsive: false };
      return window.Plotly.react(this.plot, figure.data || [], this.layoutFor(figure), config);
    }

    async render(root) {
      const src = this.getAttribute("src");
      const figure = src ? JSON.parse(await loadText(src)) : childJSON(this);
      if (!figure) throw new Error("no figure: give src or a child <script type=\"application/json\">");
      const Plotly = await waitFor("Plotly");
      const div = document.createElement("div");
      div.className = "fill";
      root.append(div);
      await Plotly.newPlot(div, figure.data || [], this.layoutFor(figure), { displaylogo: false, ...figure.config, responsive: false });
      this.plot = div;
      const copied = document.createElement("style");
      copied.textContent = [...document.querySelectorAll('style[id^="plotly.js-style-"]')]
        .flatMap((s) => [...(s.sheet ? s.sheet.cssRules : [])].map((rule) => rule.cssText))
        .join("\n");
      root.prepend(copied);
      this.observeSize(() => Plotly.Plots.resize(div));
    }

    release() {
      if (this.plot) window.Plotly.purge(this.plot);
      this.plot = null;
    }
  }

  // <cs-structure>: a 3Dmol.js viewer. 3Dmol needs only an element with a size, so it draws into a div inside
  // the shadow root; its canvas and mouse handling work there unchanged.
  const STYLES = {
    "ball-stick": { stick: { radius: 0.15 }, sphere: { scale: 0.25 } },
    stick: { stick: { radius: 0.2 } },
    sphere: { sphere: { scale: 1 } },
    line: { line: {} },
  };
  const PERIODIC = new Set(["cif"]);

  class CsStructure extends Component {
    async render(root) {
      const src = this.getAttribute("src");
      if (!src) throw new Error("no src");
      const format = (this.getAttribute("format") || src.split(/[?#]/)[0].split(".").pop()).toLowerCase();
      const viewStyle = this.getAttribute("view-style") || "ball-stick";
      if (!STYLES[viewStyle]) throw new Error(`unknown view-style "${viewStyle}"`);
      const text = await loadText(src);
      const $3Dmol = await waitFor("$3Dmol");

      const div = document.createElement("div");
      div.className = "fill";
      root.append(div);
      const viewer = $3Dmol.createViewer(div, { backgroundColor: "white", backgroundAlpha: 0, antialias: true });
      const periodic = PERIODIC.has(format);
      const model = viewer.addModel(text, format, periodic ? { doAssembly: true, normalizeAssembly: true, duplicateAssemblyAtoms: true } : {});
      const supercell = (this.getAttribute("supercell") || "").trim().split(/\s+/).map(Number);
      const valid = supercell.length === 3 && supercell.every((n) => Number.isInteger(n) && n > 0);
      // replicateUnitCell treats 1 1 1 as "3 3 3 pruned to the cell", so a single cell is left alone.
      if (periodic && valid && supercell.some((n) => n > 1)) {
        viewer.replicateUnitCell(supercell[0], supercell[1], supercell[2], model, true);
      }
      viewer.setStyle({}, STYLES[viewStyle]);
      if (periodic && !this.hasAttribute("no-cell")) viewer.addUnitCell(model, { box: { color: "#10202e" } });
      // 3Dmol looks down z, which is the c axis of most cells and hides atoms behind each other; tilt the view.
      viewer.rotate(-60, "x");
      viewer.rotate(20, "y");
      viewer.zoomTo();
      viewer.render();
      if (this.hasAttribute("spin")) viewer.spin("y", 0.5);
      this.viewer = viewer;
      this.observeSize(() => viewer.resize());
    }

    // 3Dmol draws every viewer of the page through one shared WebGL context
    release() {
      this.viewer?.spin(false);
      this.viewer = null;
    }
  }

  // <cs-molecule>: the 2D structure (skeletal formula) of the SMILES in `smiles`, drawn as SVG by SmilesDrawer. It is
  // as large as its box allows, but its atom labels are never larger than the element's font size (the body text),
  // so small molecules keep one scale. Bonds and carbon take the text colour, hydrogen the muted one; other elements
  // keep their usual colours (O red, N blue). It re-fits when its box changes size and redraws when `smiles` does.
  const LABEL_PX = (11 * 4) / 3; // SmilesDrawer's atom labels are 11pt in its drawing units
  const opaque = (css) => {
    const context = document.createElement("canvas").getContext("2d");
    context.fillStyle = css;
    return context.fillStyle; // #rrggbb
  };

  class CsMolecule extends Component {
    static observedAttributes = ["smiles"];
    static css = ".fill { display: flex; align-items: center; justify-content: center; } svg { flex: none; overflow: visible; }";

    async render(root) {
      const SmilesDrawer = await waitFor("SmilesDrawer");
      const style = getComputedStyle(this);
      await document.fonts.load(`16pt ${style.fontFamily}`); // SmilesDrawer measures the labels in this font
      const fg = opaque(style.color);
      this.drawer = new SmilesDrawer.SvgDrawer({
        fontFamily: style.fontFamily,
        compactDrawing: false, // COOH drawn as C(=O)OH: the oxygens a linker binds with are visible
        themes: { light: { C: fg, FOREGROUND: fg, H: opaque(style.getPropertyValue("--cs-muted") || "#5b6b78"), BACKGROUND: opaque(style.getPropertyValue("--cs-bg") || "#fff") } },
      });
      this.box = document.createElement("div");
      this.box.className = "fill";
      root.append(this.box);
      this.draw();
      // fitting is cheap, so every size change refits, including the first display of one drawn hidden
      const resized = new ResizeObserver(() => this.fit());
      resized.observe(this);
      (this.csObservers ||= []).push(resized);
    }

    draw() {
      const smiles = (this.getAttribute("smiles") || "").trim();
      if (!smiles) throw new Error("no smiles");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", smiles);
      this.box.replaceChildren(svg);
      let failed = null;
      window.SmilesDrawer.parse(smiles, (tree) => this.drawer.draw(tree, svg, "light"), (error) => (failed = error));
      if (failed) throw new Error(`cannot read SMILES "${smiles}": ${failed.message || failed}`);
      this.svg = svg;
      this.fit();
    }

    // The drawing, cropped to what was drawn and scaled to the box. Not measurable while the element is not
    // displayed (a hidden tab): it fits once it is, when its size changes.
    fit() {
      const b = this.svg.getBBox();
      if (!b.width) return;
      const pad = 2;
      const [width, height] = [b.width + 2 * pad, b.height + 2 * pad];
      const largest = parseFloat(getComputedStyle(this).fontSize) / LABEL_PX;
      const scale = Math.min(largest, (this.clientWidth || Infinity) / width, (this.clientHeight || Infinity) / height);
      this.svg.setAttribute("viewBox", `${b.x - pad} ${b.y - pad} ${width} ${height}`);
      this.svg.setAttribute("width", String(width * scale));
      this.svg.setAttribute("height", String(height * scale));
    }

    // a slide script setting another SMILES
    attributeChangedCallback() {
      if (this.csState !== "ready") return;
      try {
        this.draw();
      } catch (error) {
        this.box.replaceChildren(Object.assign(document.createElement("div"), { className: "error", textContent: `cs-molecule: ${error.message}` }));
      }
    }
  }

  // <cs-table>: CSV with a header row from src, or child JSON {columns, rows}; click a heading to sort.
  const parseCSV = (text) => {
    const rows = [[]];
    let field = "";
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') field += text[++i];
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") rows[rows.length - 1].push(field), (field = "");
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        rows[rows.length - 1].push(field);
        field = "";
        rows.push([]);
      } else field += c;
    }
    rows[rows.length - 1].push(field);
    const nonEmpty = rows.filter((row) => row.length > 1 || row[0] !== "");
    return { columns: nonEmpty[0] || [], rows: nonEmpty.slice(1) };
  };

  const asNumber = (value) => {
    if (typeof value === "number") return value;
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    return Number.isFinite(n) ? n : null;
  };

  class CsTable extends Component {
    static css = `
      :host { overflow: auto; }
      table { border-collapse: collapse; width: 100%; font-size: var(--cs-small, 28px); }
      th, td { padding: 14px 20px; text-align: left; border-bottom: 2px solid var(--cs-rule, #d7dee3); }
      th { color: var(--cs-accent, #007390); font-weight: 600; cursor: pointer; user-select: none; white-space: nowrap; }
      th[aria-sort="ascending"]::after { content: " \\25B2"; }
      th[aria-sort="descending"]::after { content: " \\25BC"; }
      td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
      tbody tr:nth-child(even) { background: var(--cs-code-bg, #f3f5f7); }`;

    async render(root) {
      const src = this.getAttribute("src");
      const table = src ? parseCSV(await loadText(src)) : childJSON(this);
      if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) {
        throw new Error("no table: give a CSV src or a child JSON {columns, rows}");
      }
      const numeric = table.columns.map((_, j) => table.rows.every((row) => row[j] == null || row[j] === "" || asNumber(row[j]) !== null));
      const el = document.createElement("table");
      const head = el.createTHead().insertRow();
      const body = el.createTBody();
      let rows = table.rows.slice();
      const fill = () => {
        body.replaceChildren(...rows.map((row) => {
          const tr = document.createElement("tr");
          table.columns.forEach((_, j) => {
            const td = tr.insertCell();
            td.textContent = row[j] == null ? "" : String(row[j]);
            if (numeric[j]) td.className = "num";
          });
          return tr;
        }));
      };
      table.columns.forEach((name, j) => {
        const th = document.createElement("th");
        th.textContent = name;
        if (numeric[j]) th.className = "num";
        th.addEventListener("click", () => {
          const dir = th.getAttribute("aria-sort") === "ascending" ? -1 : 1;
          head.querySelectorAll("th").forEach((other) => other.removeAttribute("aria-sort"));
          th.setAttribute("aria-sort", dir === 1 ? "ascending" : "descending");
          const key = (row) => (numeric[j] ? asNumber(row[j]) ?? -Infinity : String(row[j] ?? ""));
          rows.sort((a, b) => {
            const x = key(a), y = key(b);
            return dir * (numeric[j] ? x - y : x.localeCompare(y));
          });
          fill();
        });
        head.append(th);
      });
      fill();
      root.append(el);
    }
  }

  // <cs-embed>: an iframe of another page. Sandboxed (no top navigation, no downloads); scripts, forms and
  // popups are allowed. In the editor the slide itself is sandboxed without allow-same-origin, which the
  // embedded page inherits: it runs without its own cookies or storage. Ready on load, or after 10 s.
  class CsEmbed extends Component {
    static css = "iframe { border: 0; width: 100%; height: 100%; display: block; }";

    async render(root) {
      const src = this.getAttribute("src");
      if (!src) throw new Error("no src");
      const frame = document.createElement("iframe");
      frame.className = "fill";
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
      frame.setAttribute("referrerpolicy", "no-referrer");
      // in the editor's edit mode the box is selected and dragged, so the page must not take the pointer
      if (document.documentElement.dataset.mode === "edit") frame.style.pointerEvents = "none";
      frame.src = new URL(src, document.baseURI).href;
      const loaded = new Promise((resolve) => {
        frame.addEventListener("load", resolve, { once: true });
        setTimeout(resolve, 10000);
      });
      root.append(frame);
      await loaded;
    }
  }

  // <a data-popup href="...">: opens the page in a window of its own, beside the slides. The editor's frames let
  // popups escape their sandbox, so the page has its own cookies and logins (an app behind IAP works, unlike in
  // cs-embed). data-popup="1600x1000" sets the window size; a target attribute names the window, so a second
  // click reuses it.
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[data-popup]");
    if (!link) return;
    event.preventDefault();
    const [width, height] = (link.dataset.popup || "1600x1000").split("x");
    window.open(link.href, link.target || "_blank", `popup,width=${width},height=${height}`);
  });

  customElements.define("cs-plot", CsPlot);
  customElements.define("cs-structure", CsStructure);
  customElements.define("cs-molecule", CsMolecule);
  customElements.define("cs-table", CsTable);
  customElements.define("cs-embed", CsEmbed);
  window.cslidesComponent = Component; // the base class, for components bundled elsewhere (cs-matterviz, cs-math)
})();
