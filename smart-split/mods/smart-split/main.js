// Splits the focused pane along its longer side: to the right when it's wide,
// down when it's tall. A key opens it (mod.open:smart-split) as an invisible
// popup that splits once and closes itself.
//
// The pane's shape comes from its terminal's columns and rows (hc get) plus the
// layout's terminal padding, so a pane whose text is narrowed by a wide side
// padding (reading-width) still counts as wide.

import { View, div } from "gpui-kit";
import { closeOverlay, focused, hc, layout, notify, props, run, settings } from "herdr";

// A monospace cell's width, in font sizes.
const CELL_EM = 0.6;
// How much taller a terminal cell is than it is wide. Measured on the
// default font: a 142x65 pane draws about 1255x1365 px, so ~2.4.
const CELL_ASPECT = 2.4;

// [horizontal, vertical], the order terminal_padding uses.
function sides(padding) {
  if (Array.isArray(padding)) return [padding[0], padding[1] ?? padding[0]];
  return typeof padding === "number" ? [padding, padding] : [0, 0];
}

// The pane's size in px at zoom 1, from its terminal's grid and padding.
function paneSize(cols, rows) {
  const tree = layout();
  const font = Number(tree?.font_size ?? settings().font_size) || 14;
  const [padH, padV] = sides(tree?.terminal_padding);
  const cell = font * CELL_EM;
  return { width: cols * cell + 2 * padH, height: rows * cell * CELL_ASPECT + 2 * padV };
}

async function split() {
  const f = focused();
  if (!f?.pane) return;
  let direction = "right";
  if (f.terminal) {
    const r = await hc(["get", f.terminal, "--json"]);
    if (r.code === 0) {
      const { cols, rows } = JSON.parse(r.stdout);
      if (cols && rows) {
        const size = paneSize(cols, rows);
        if (size.width < size.height) direction = "down";
      }
    }
  }
  run("pane.split", { direction, pane: f.pane });
}

export default class SmartSplit extends View {
  init(_props, cx) {
    cx.spawn(async () => {
      try {
        await split();
      } catch (e) {
        notify({ title: "Smart split", body: String(e?.message ?? e), level: "error" });
      }
      closeOverlay(props().overlay);
    });
  }

  render() {
    return div();
  }
}
