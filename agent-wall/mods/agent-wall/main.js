// Toggles the current space's agents into a wall of panes, and back.
//
// On: the layout's "main" block (the shown tab) is swapped for a grid of
// terminal blocks, one per agent in the focused space, from every tab.
// The grid follows the shape of the space it fills: a tall window stacks
// agents, a wide one puts them side by side. Two zero-size probe blocks in the
// wall (copies of this mod) measure it and re-arrange it when that changes.
// Off: the original "main" block comes back, focused on the agent you were
// on in the wall (else the pane that had focus before). The original block
// is kept in shared state, so the wall survives a restart and can still be
// undone.

import { View, div } from "gpui-kit";
import { agents, closeOverlay, focused, layout, nextCommand, notify, panes, props, run, setShared, shared } from "herdr";

const WALL_ID = "agent-wall";
const MAIN_ID = "main";
const GRID_ID = `${WALL_ID}-grid`;
const STATE_KEY = "agent-wall.saved";
const SIZE_KEY = "agent-wall.size";
const MAX_PER_ROW = 3;
// The cell shape (width / height) the grid aims for. Terminals read best a
// little wider than tall, but a square target keeps 2 agents side by side on
// a landscape window and stacked on a portrait one.
const TARGET_ASPECT = 1;

// How many columns suit n agents in a width × height area: the count whose
// cells come closest to TARGET_ASPECT on average. Cells are scored as
// rowSizes actually lays them out, so a short row's wider cells count too
// (3 agents in 2 columns is 1+2, not a 2×2 grid). Without a size, as many as
// fit a row.
export function columnsFor(n, size) {
  const most = Math.min(n, MAX_PER_ROW);
  if (!size?.width || !size?.height) return most;
  let best = most;
  let bestScore = Infinity;
  for (let cols = 1; cols <= most; cols++) {
    const sizes = rowSizes(n, cols);
    const rowHeight = size.height / sizes.length;
    const score =
      sizes.reduce((sum, count) => sum + count * Math.abs(Math.log(size.width / count / rowHeight / TARGET_ASPECT)), 0) / n;
    if (score < bestScore - 1e-9) {
      best = cols;
      bestScore = score;
    }
  }
  return best;
}

// Splits n agents into rows of at most `cols`, as even as possible, with the
// wider rows last (3 cols: 4 → 2+2, 5 → 2+3, 7 → 2+2+3; 1 col: one per row).
export function rowSizes(n, cols = MAX_PER_ROW) {
  if (n <= 0) return [];
  const rows = Math.ceil(n / cols);
  const base = Math.floor(n / rows);
  const extra = n % rows;
  return Array.from({ length: rows }, (_, i) => base + (i >= rows - extra ? 1 : 0));
}

function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function findParent(node, id) {
  for (const child of node?.children ?? []) {
    if (child.id === id) return node;
    const found = findParent(child, id);
    if (found) return found;
  }
  return null;
}

// A 0px block: a probe another mod keeps in the layout (reading-width's).
const isProbeBlock = (node) => node.type === "block" && node.size?.px === 0;

// What the wall takes the place of: the "main" block, or the column or row
// wrapping it when its other children are only 0px blocks. Replacing the
// wrapper keeps the tree shallow enough for layout.set, and the wall keeps
// those blocks (`keep`) so their mods go on running.
function wallTarget(tree, main) {
  const parent = findParent(tree, MAIN_ID);
  const others = (parent?.children ?? []).filter((c) => c.id !== MAIN_ID);
  if (parent && parent !== tree && parent.type !== "stack" && others.length && others.every(isProbeBlock)) {
    return { node: parent, keep: others };
  }
  return { node: main, keep: [] };
}

// A copy of the tree with the node `id` replaced by `replacement`.
function replaceNode(node, id, replacement) {
  if (node.id === id) return replacement;
  if (!node.children) return node;
  return { ...node, children: node.children.map((c) => replaceNode(c, id, replacement)) };
}

// A zero-size block running a probe copy of this mod, which reports one side
// of the wall ("w": it spans the width, "h": it spans the height).
const probe = (side) => ({
  id: `${WALL_ID}-probe-${side}`,
  type: "block",
  size: { px: 0 },
  content: { mod: WALL_ID, props: { probe: side } },
});

function wallNode(addresses, look, size, keep = []) {
  const sizes = rowSizes(addresses.length, columnsFor(addresses.length, size));
  let next = 0;
  const cell = (address) => ({
    id: `${WALL_ID}-${address.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
    type: "block",
    content: { terminal: address },
    background: look.background ?? "background",
    border: look.border ?? { width: 1, color: "border" },
    focus: { border: look.focus ?? { width: 1, color: "accent" } },
    radius: look.radius ?? 10,
  });
  const gap = look.gap ?? 8;
  // Kept shallow on purpose: layout.set refuses arguments nested more than
  // 16 levels, and a cell's focus border already sits deep in the tree.
  const rows = sizes.map((count, r) => ({
    id: `${WALL_ID}-row-${r}`,
    type: "row",
    gap,
    children: addresses.slice(next, (next += count)).map(cell),
  }));
  return {
    id: WALL_ID,
    type: "row",
    resizable: false,
    children: [probe("h"), { id: GRID_ID, type: "column", gap, resizable: false, children: [probe("w"), ...keep, ...rows] }],
  };
}

// The wall's rows, as lists of terminal addresses.
const gridRows = (tree) =>
  (findNode(tree, GRID_ID)?.children ?? [])
    .filter((row) => row.type === "row")
    .map((row) => (row.children ?? []).map((cell) => cell.content?.terminal));

// Rebuilds a shown wall when the measured size calls for another arrangement.
function relayout() {
  const tree = layout();
  if (!tree || !findNode(tree, WALL_ID)) return;
  const rows = gridRows(tree);
  const addresses = rows.flat().filter(Boolean);
  const want = rowSizes(addresses.length, columnsFor(addresses.length, shared(SIZE_KEY)));
  if (want.join() === rows.map((r) => r.length).join()) return;
  const current = focused()?.terminal;
  const saved = shared(STATE_KEY);
  const look = saved?.look ?? saved?.main?.content?.pane ?? {};
  const own = probe("w").id;
  const keep = (findNode(tree, GRID_ID)?.children ?? []).filter((c) => c.id !== own && isProbeBlock(c));
  run("layout.set", { layout: replaceNode(tree, WALL_ID, wallNode(addresses, look, shared(SIZE_KEY), keep)) });
  if (current && addresses.includes(current)) run("pane.focus", { terminal: current });
}

// A probe copy reports its side; the first report of a new size re-arranges.
function report(side, size) {
  const value = Math.round(side === "w" ? size.width : size.height);
  if (!value) return;
  const known = shared(SIZE_KEY) ?? {};
  const key = side === "w" ? "width" : "height";
  if (known[key] === value) return;
  setShared(SIZE_KEY, { ...known, [key]: value });
  relayout();
}

function toggle() {
  const tree = layout();
  if (!tree || typeof tree !== "object") throw new Error("No layout is shown.");
  const saved = shared(STATE_KEY);

  if (findNode(tree, WALL_ID)) {
    if (!saved?.main) throw new Error("The original layout block was lost; switch layouts to recover.");
    // Land on the agent focused in the wall, else the pane focused before it.
    const inWall = focused()?.terminal;
    const pane = panes().find((p) => inWall && p.terminal === inWall)?.pane ?? saved.pane;
    run("layout.set", { layout: replaceNode(tree, WALL_ID, saved.main) });
    setShared(STATE_KEY, null);
    if (pane) run("pane.focus", { pane });
    return;
  }

  const main = findNode(tree, MAIN_ID);
  if (!main) throw new Error(`This layout has no "${MAIN_ID}" block to turn into a wall.`);
  const f = focused();
  const list = agents().filter((a) => a.space === f?.space);
  if (list.length === 0) {
    notify({ title: "Agent wall", body: "No agents in this space.", level: "info" });
    return;
  }

  // `main` is what the wall replaced (maybe main's wrapper), put back as is.
  const target = wallTarget(tree, main);
  const look = main.content?.pane ?? {};
  setShared(STATE_KEY, { main: target.node, look, pane: f?.pane ?? null });
  const wall = wallNode(list.map((a) => a.address), look, shared(SIZE_KEY), target.keep);
  run("layout.set", { layout: replaceNode(tree, target.node.id, wall) });
  const first = list.find((a) => a.focused) ?? list[0];
  run("pane.focus", { terminal: first.address });
}

// Moves focus inside the wall: left/right along a row, up/down to the cell
// of the next row that overlaps the current one most. Outside the wall
// (or when focus isn't on a wall cell) it is plain pane.go.
function go(direction) {
  const tree = layout();
  const wall = findNode(tree, WALL_ID);
  const current = focused()?.terminal;
  const rows = gridRows(tree);
  const r = rows.findIndex((row) => row.includes(current));
  if (!wall || r < 0) {
    run("pane.go", { direction });
    return;
  }
  const c = rows[r].indexOf(current);
  let target = null;
  if (direction === "left") target = rows[r][c - 1];
  if (direction === "right") target = rows[r][c + 1];
  if (direction === "up" || direction === "down") {
    const next = rows[r + (direction === "up" ? -1 : 1)];
    if (next) {
      const center = (c + 0.5) / rows[r].length;
      target = next[Math.min(next.length - 1, Math.floor(center * next.length))];
    }
  }
  if (target) run("pane.focus", { terminal: target });
}

const COMMANDS = {
  toggle,
  left: () => go("left"),
  right: () => go("right"),
  up: () => go("up"),
  down: () => go("down"),
};

function attempt(fn) {
  try {
    fn();
  } catch (e) {
    notify({ title: "Agent wall", body: String(e?.message ?? e), level: "error" });
  }
}

// Three ways in:
// - a copy docked in the layout (props.nav, a 0px block always shown) takes
//   key commands: agent-wall.toggle and agent-wall.left|right|up|down;
// - opened by a key with mod.open, it toggles once and closes itself;
// - a probe block inside the wall (props.probe) measures it.
export default class AgentWall extends View {
  init(_props, cx) {
    this.probe = props()?.probe ?? null;
    if (this.probe) return;
    if (props()?.nav) {
      cx.spawn(async () => {
        for (;;) {
          const command = COMMANDS[await nextCommand()];
          if (command) attempt(command);
        }
      });
      return;
    }
    cx.spawn(async () => {
      attempt(toggle);
      closeOverlay(props().overlay);
    });
  }

  render() {
    if (!this.probe) return div();
    const side = this.probe;
    return div()
      .id(`probe-${side}`)
      .size_full()
      .on_size_change((size) => attempt(() => report(side, size)));
  }
}
