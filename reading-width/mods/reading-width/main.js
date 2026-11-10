// Keeps an agent's text at a readable width. When an agent is the only pane on
// screen (alone in its tab, or zoomed), it widens the layout's side terminal
// padding so the text stops at about COLUMNS columns, centered. The pane keeps
// its full width: only the text inside it narrows. Everything else gets the
// layout's own padding back.
//
// The layout shows a copy as a 0px-tall block right above its tab block, in a
// column with it, so the copy is as wide as the tab block and measures it.
// props: { columns?: number } (default COLUMNS).

import { View, div } from "gpui-kit";
import { focused, layout, panes, props, run, setShared, settings, shared } from "herdr";

const COLUMNS = 120;
// A monospace cell's width, in font sizes.
const CELL_EM = 0.6;
// Padding changes smaller than this are skipped, so a window drag doesn't
// resize the terminal on every pixel.
const PAD_STEP = 16;
// Shared while the padding is widened: { layout, base }, base being the
// layout's own terminal_padding (null when it sets none).
const STATE_KEY = "reading-width.base";

// [horizontal, vertical], the order terminal_padding uses.
function sides(padding) {
  if (Array.isArray(padding)) return [padding[0], padding[1] ?? padding[0]];
  return typeof padding === "number" ? [padding, padding] : [10, 6];
}

const samePadding = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function withPadding(tree, padding) {
  const next = { ...tree };
  if (padding == null) delete next.terminal_padding;
  else next.terminal_padding = padding;
  return next;
}

function hasTabBlock(node) {
  if (!node || typeof node !== "object") return false;
  if (node.content?.tab) return true;
  return (node.children ?? []).some(hasTabBlock);
}

// Sets the side padding to `side` px, or back to the layout's own with null.
function narrowTo(side) {
  const tree = layout();
  if (!tree || typeof tree !== "object") return;
  const name = shared("layout");
  const saved = shared(STATE_KEY);
  const mine = saved?.layout === name ? saved : null;
  const base = mine ? mine.base : tree.terminal_padding ?? null;
  const [h, v] = sides(base);

  if (side != null && side > h) {
    const [now] = sides(tree.terminal_padding);
    if (mine && Math.abs(now - side) < PAD_STEP) return;
    if (!mine) setShared(STATE_KEY, { layout: name, base });
    run("layout.set", { layout: withPadding(tree, [side, v]) });
  } else if (mine) {
    setShared(STATE_KEY, null);
    if (!samePadding(tree.terminal_padding, base)) run("layout.set", { layout: withPadding(tree, base) });
  }
}

export default class ReadingWidth extends View {
  init() {
    this.width = 0;
    this.wanted = undefined;
  }

  // The side padding to ask for: px to narrow, null for the layout's own,
  // undefined while there's nothing to measure yet.
  wantedSide() {
    if (!this.width) return undefined;
    const tree = layout();
    // No tab block shown (another mod replaced it, like agent-wall): its
    // terminals are someone else's, so give them the layout's padding.
    if (!hasTabBlock(tree)) return null;
    const f = focused();
    if (!f) return undefined;
    const tab = panes().filter((p) => p.tab === f.tab);
    const shown = tab.find((p) => p.zoomed) ?? (tab.length === 1 ? tab[0] : null);
    if (!shown?.terminal || !(shown.program?.agent || shown.status)) return null;
    const font = Number(tree?.font_size ?? settings().font_size) || 14;
    const columns = Number(props()?.columns) || COLUMNS;
    return Math.floor((this.width - columns * font * CELL_EM) / 2);
  }

  sync() {
    const want = this.wantedSide();
    if (want === undefined || want === this.wanted) return;
    this.wanted = want;
    narrowTo(want);
  }

  render(cx) {
    // The shown pane can change without this block changing size (a tab
    // switch, a split, an agent starting in a shell): check after each render.
    if (this.wantedSide() !== this.wanted) cx.timer.after(0, () => this.sync());
    return div()
      .id("reading-width-probe")
      .size_full()
      .on_size_change((size) => {
        this.width = size.width / (Number(settings().zoom) || 1);
        this.sync();
      });
  }
}
