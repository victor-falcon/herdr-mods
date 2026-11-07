// Toggles the current space's agents into a wall of panes, and back.
//
// On: the layout's "main" block (the shown tab) is swapped for a grid of
// terminal blocks, one per agent in the focused space, from every tab.
// Off: the original "main" block comes back, focused on the agent you were
// on in the wall (else the pane that had focus before). The original block
// is kept in shared state, so the wall survives a restart and can still be
// undone.

import { View, div } from "gpui-kit";
import { agents, closeOverlay, focused, layout, nextCommand, notify, panes, props, run, setShared, shared } from "herdr";

const WALL_ID = "agent-wall";
const MAIN_ID = "main";
const STATE_KEY = "agent-wall.saved";
const MAX_PER_ROW = 3;

// Splits n agents into rows: up to 3 in one row, then rows of at most 3,
// as even as possible, with the wider rows last (4 → 2+2, 5 → 2+3, 7 → 2+2+3).
export function rowSizes(n) {
  if (n <= 0) return [];
  const rows = Math.ceil(n / MAX_PER_ROW);
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

// A copy of the tree with the node `id` replaced by `replacement`.
function replaceNode(node, id, replacement) {
  if (node.id === id) return replacement;
  if (!node.children) return node;
  return { ...node, children: node.children.map((c) => replaceNode(c, id, replacement)) };
}

function wallNode(addresses, look) {
  const sizes = rowSizes(addresses.length);
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
  return {
    id: WALL_ID,
    type: "column",
    gap,
    children: sizes.map((count, r) => ({
      id: `${WALL_ID}-row-${r}`,
      type: "row",
      gap,
      children: addresses.slice(next, (next += count)).map(cell),
    })),
  };
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

  setShared(STATE_KEY, { main, pane: f?.pane ?? null });
  run("layout.set", { layout: replaceNode(tree, MAIN_ID, wallNode(list.map((a) => a.address), main.content?.pane ?? {})) });
  const first = list.find((a) => a.focused) ?? list[0];
  run("pane.focus", { terminal: first.address });
}

// Moves focus inside the wall: left/right along a row, up/down to the cell
// of the next row that overlaps the current one most. Outside the wall
// (or when focus isn't on a wall cell) it is plain pane.go.
function go(direction) {
  const wall = findNode(layout(), WALL_ID);
  const current = focused()?.terminal;
  const rows = (wall?.children ?? []).map((row) => (row.children ?? []).map((cell) => cell.content?.terminal));
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

// Two ways in:
// - a copy docked in the layout (props.nav, a 0px block always shown) takes
//   key commands: agent-wall.toggle and agent-wall.left|right|up|down;
// - opened by a key with mod.open, it toggles once and closes itself.
export default class AgentWall extends View {
  init(_props, cx) {
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
    return div();
  }
}
