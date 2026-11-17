// agent-tasks in Herdr: what `agent-tasks top` shows, as a small foldable
// sidebar panel and as a full dashboard pane. Everything comes from the CLI:
// `agent-tasks top --json` for the dashboard, `log <ref> --json` and
// `show <task> --json` for one run, and its commands for the actions
// (retry, run, pause, resume). The only files read directly are the ones the
// CLI points at (a run's --output-file).
//
// One snapshot is shared by every copy (block and pane) through `shared`, so
// they don't each run the CLI.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, readTextFile, watchFolder, shared, setShared, run, panes, focused, spaces, terminals, machines } from "herdr";

const SNAP_KEY = "agent-tasks.snapshot"; // { dash, at, error, missing, schema, machine }
const FETCHED_KEY = "agent-tasks.fetchedAt"; // ms of the last `top --json` any copy started
const FOLDED_KEY = "agent-tasks.folded"; // the sidebar panel
const GROUPS_KEY = "agent-tasks.groups"; // { [group]: true } folded groups in the sidebar
const PANE_GROUPS_KEY = "agent-tasks.paneGroups"; // the same in the dashboard pane
const SELECT_KEY = "agent-tasks.select"; // { ref, at }: the sidebar asks the pane to show a run
const MACHINE_KEY = "agent-tasks.machine"; // { machine }: where agent-tasks was found (no props.machine)

const MOD = "agent-tasks";
const SCHEMA = 1;
// DEFAULT_DATA_DIR in agent-tasks' src/paths.ts: watched until the CLI says
// where its data folder is (`data_dir` in `top --json`).
const DEFAULT_DATA_DIR = "~/.local/share/agent-tasks";
const MINUTE = 60000;
// A change seen by the watcher is read after this much quiet.
const DEBOUNCE_MS = 700;
// Never read more often than this, whatever changes.
const MIN_GAP_MS = 1500;
const MONO = "JetBrains Mono";
// Rows a group shows in the sidebar; the dashboard has the rest.
const SIDEBAR_ROWS = 5;
// Lines of a run's log drawn in the pane (the end of it).
const LOG_LINES = 400;

// ---------------------------------------------------------------------------
// Options and data
// ---------------------------------------------------------------------------

// props: { machine } — the Herdr machine (a space's `machine`) agent-tasks
// runs on. Left out, the machine found by `findMachine` (shared by every
// copy): this computer if agent-tasks runs here, else the first connected
// machine where it does.
// -> { machine, fixed: set in props, known: decided (else still looking), dir }
export function tasksOptions(p, dir) {
  const fixed = typeof p?.machine === "string" && p.machine ? p.machine : null;
  if (fixed) return { machine: fixed, fixed: true, known: true, dir };
  const found = shared(MACHINE_KEY);
  return { machine: found?.machine ?? null, fixed: false, known: Boolean(found), dir };
}

const answers = async (on) => {
  try {
    return (await exec("agent-tasks", ["version"], on ? { on } : undefined)).code === 0;
  } catch {
    return false;
  }
};

// Looks for agent-tasks here, then on each ready machine, and remembers the
// first that answers. Found nowhere: nothing is remembered (this computer is
// used, which says the CLI is missing) and the next read looks again.
async function findMachine() {
  if (await answers(null)) return setShared(MACHINE_KEY, { machine: null });
  for (const m of machines()) {
    if (m.name && m.layout === "ready" && (await answers(m.name))) return setShared(MACHINE_KEY, { machine: m.name });
  }
}

const onMachine = (o) => (o.machine ? { on: o.machine } : undefined);

const expandHome = (path) => (path.startsWith("~/") ? `${home()}${path.slice(1)}` : path);

// Runs `agent-tasks <args> --json` -> { json } | { error } | { missing }.
async function cli(o, args) {
  let r;
  try {
    r = await exec("agent-tasks", [...args, "--json"], onMachine(o));
  } catch (e) {
    // exec rejects when the program can't start: for a bare name, it isn't on PATH.
    const message = String(e?.message ?? e);
    return /not found|no such file|enoent/i.test(message) ? { missing: true, error: message } : { error: message };
  }
  if (r.code === 127) return { missing: true, error: "agent-tasks not found" };
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    // Not JSON: the error is in stderr.
  }
  if (r.code !== 0) {
    // `retry` and `run` exit 1 when the launch failed, with the reason in a `failed` event.
    const failed = (json?.events ?? []).find((e) => e?.type === "failed");
    const reason = json?.error?.message ?? failed?.message ?? failed?.reason ?? (r.stderr.trim() || `agent-tasks exited with ${r.code}`);
    return { error: String(reason), json };
  }
  if (!json) return { error: "agent-tasks printed no JSON" };
  return { json };
}

export function snapshot(o) {
  const s = shared(SNAP_KEY);
  return s && (s.machine ?? null) === o.machine ? s : null;
}

// Reads `top --json` into the shared snapshot. A failure keeps the last good
// dashboard and says why.
async function fetchDashboard(o) {
  const r = await cli(o, ["top"]);
  const prev = snapshot(o);
  const base = { dash: prev?.dash ?? null, at: prev?.at ?? null, machine: o.machine, error: null, missing: false, schema: null };
  if (r.missing) return setShared(SNAP_KEY, { ...base, missing: true });
  if (r.error) return setShared(SNAP_KEY, { ...base, error: r.error });
  const schema = r.json.schema;
  if (schema !== undefined && schema !== SCHEMA) return setShared(SNAP_KEY, { ...base, schema });
  setShared(SNAP_KEY, { ...base, dash: r.json, at: Date.now() });
}

const sinceFetch = () => Date.now() - (Number(shared(FETCHED_KEY)) || 0);

// The CLI's data folder: `data_dir` in `top --json` (newer CLIs), else what
// the runner's start line in `runner.log` says (`… · data: ~/…`), else the
// default. `~` only means something on this computer.
export function dataDir(o) {
  const dash = snapshot(o)?.dash;
  if (typeof dash?.data_dir === "string" && dash.data_dir) return dash.data_dir;
  const said = (dash?.events ?? []).map((l) => / · data: (\S+)\s*$/.exec(l)?.[1]).filter(Boolean).at(-1);
  const dir = said ?? DEFAULT_DATA_DIR;
  if (!dir.startsWith("~")) return dir;
  return o.machine ? null : expandHome(dir);
}

// Appends to a run's captured log change nothing `top` shows.
const relevant = (paths) => !Array.isArray(paths) || paths.length === 0 || paths.some((p) => !/\/runs\/.+\.log$/.test(p));

// Keeps the snapshot fresh: on changes in the data folder (debounced), every
// minute (relative times and the runner's health move on their own), and on
// request (`refresh`). `options()` is read each time: props can change.
export function startTasks(cx, options) {
  let busy = false;
  let changedAt = 0; // a change seen and not read yet
  let watching = false;
  let checked = null; // the folder last found missing here
  // Claims the read through the shared clock before anything is awaited, so
  // two copies don't both run the CLI.
  const refresh = (cx) => {
    if (busy || sinceFetch() < MIN_GAP_MS) return;
    busy = true;
    changedAt = 0;
    setShared(FETCHED_KEY, Date.now());
    cx.spawn(async (cx) => {
      try {
        if (!options().known) await findMachine();
        const o = options();
        await fetchDashboard(o);
        // The machine found earlier lost agent-tasks (or went away): look again next time.
        const st = snapshot(o);
        if (!o.fixed && o.known && (st?.missing || /unreachable|offline|not connected/i.test(st?.error ?? ""))) setShared(MACHINE_KEY, null);
      } finally {
        busy = false;
      }
      if (!watching) watch(cx);
    });
  };
  // watchFolder only sees this computer. `data_dir` can be another
  // machine's path (on a client machine `top` runs on the hub over SSH), so
  // it is watched only if it exists here; otherwise the minute timer reads.
  const watch = (cx) => {
    const o = options();
    const dir = dataDir(o);
    if (o.machine || !dir || dir === checked) return;
    watching = true;
    cx.spawn(async () => {
      const here = await exec("test", ["-d", dir]).then((r) => r.code === 0, () => false);
      if (!here) {
        checked = dir;
        watching = false;
        return;
      }
      try {
        for (;;) {
          const paths = await watchFolder(dir);
          if (relevant(paths)) changedAt = Date.now();
          // The CLI moved its data folder: watch the new one.
          if (dataDir(options()) !== dir) break;
        }
      } catch {
        // Can't watch it: the minute timer reads.
      }
      watching = false;
    });
  };
  const o = options();
  if (!o.known || !snapshot(o)?.dash || sinceFetch() > 10000) refresh(cx);
  else watch(cx);
  cx.timer.every(500, (cx) => {
    if (busy) return;
    const fetched = Number(shared(FETCHED_KEY)) || 0;
    // Another copy may have read it since the change.
    if (changedAt && fetched >= changedAt) changedAt = 0;
    if (changedAt && Date.now() - changedAt >= DEBOUNCE_MS) return refresh(cx);
  });
  cx.timer.every(MINUTE, (cx) => {
    if (sinceFetch() >= MINUTE - 5000) refresh(cx);
    cx.notify();
  });
  return { refresh };
}

// ---------------------------------------------------------------------------
// Words, times and marks
// ---------------------------------------------------------------------------

const IN_PROGRESS = ["running", "blocked"];
const RETRYABLE = ["failed", "timed_out", "missed"];

const pad2 = (n) => String(n).padStart(2, "0");
const parse = (iso) => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? null : ms;
};
const sameDay = (a, b) => {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
};
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function clock(ms, seconds = false) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}${seconds ? `:${pad2(d.getSeconds())}` : ""}`;
}

// `14:05` today, `Mon 14:05` this week, else `17/11 14:05`.
function formatWhen(ms, now) {
  if (sameDay(ms, now)) return clock(ms);
  const d = new Date(ms);
  return Math.abs(now - ms) < 6 * 86400000 ? `${DAYS[d.getDay()]} ${clock(ms)}` : `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${clock(ms)}`;
}

// The recent column: `HH:MM` today, else the weekday or the date.
function shortWhen(ms, now) {
  if (sameDay(ms, now)) return clock(ms);
  const d = new Date(ms);
  return Math.abs(now - ms) < 6 * 86400000 ? DAYS[d.getDay()] : `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
}

export function span(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

// `in 23h`, `in 5m`: the coarse unit only, like a list column.
function inTime(ms) {
  const m = Math.max(0, Math.round(ms / MINUTE));
  if (m < 1) return "now";
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `in ${h}h` : `in ${Math.round(h / 24)}d`;
}

function mark(t, status) {
  switch (status) {
    case "running": return { glyph: "◐", color: t.ansi4 };
    case "blocked": return { glyph: "!", color: t.ansi3 };
    case "succeeded": return { glyph: "■", color: t.ansi2 };
    case "failed":
    case "timed_out": return { glyph: "×", color: t.ansi1 };
    case "missed": return { glyph: "□", color: t.dim };
    case "paused": return { glyph: "‖", color: t.dim };
    case "next": return { glyph: "○", color: t.dim };
    default: return { glyph: "-", color: t.dim };
  }
}

const statusWord = (status) => (status === "succeeded" ? "ok" : status === "timed_out" ? "timed out" : status);

// The runner can't start anything: stale or never ticked.
const stopped = (dash) => dash?.runner && dash.runner.state !== "healthy";

// Slots whose time has passed while nothing ran them.
const pastDue = (dash) => {
  const now = parse(dash?.now) ?? Date.now();
  return (dash?.next ?? []).filter((n) => n.state === "active" && (parse(n.at) ?? Infinity) < now).length;
};

export function needsAttention(dash) {
  if (!dash) return false;
  const today = dash.today ?? {};
  return stopped(dash) || today.failed > 0 || today.blocked > 0 || today.missed > 0;
}

const isEmpty = (dash) => !dash.running?.length && !dash.next?.length && !dash.recent?.length;

// A run's latest state from the snapshot (running first, then recent).
const findRun = (dash, ref) => (dash?.running ?? []).find((r) => r.ref === ref) ?? (dash?.recent ?? []).find((r) => r.ref === ref) ?? null;
const findTask = (dash, id) => (dash?.next ?? []).find((n) => n.task_id === id) ?? null;

// What the sidebar or pane says instead of (or above) the lists.
// -> [{ kind: "error" | "warn" | "info", text, tip? }]
function banners(st) {
  if (st?.missing) return [{ kind: "warn", text: "agent-tasks isn't on your login PATH." }, { kind: "info", text: "In its checkout: bin/agent-tasks install", mono: true }];
  if (st?.schema != null) return [{ kind: "warn", text: `agent-tasks speaks schema ${st.schema}: update this mod.` }];
  if (st?.error) return [{ kind: "warn", text: `Couldn't refresh: ${st.error}`, tip: st.error }];
  // Task or run files the CLI couldn't read (`top` says the same).
  const errors = st?.dash?.errors ?? [];
  if (errors.length) return [{ kind: "warn", text: `${plural(errors.length, "file")} couldn't be read`, tip: errors.join("\n") }];
  return [];
}

// The groups both views list, in order.
const GROUPS = [
  { id: "running", name: "Running" },
  { id: "next", name: "Next" },
  { id: "recent", name: "Recent" },
];

const EMPTY_HINT = ["Nothing scheduled yet. Ask an agent:", "“Every Monday at 9, sum up my open PRs.”"];

function stoppedNote(dash) {
  const due = pastDue(dash);
  return `Nothing starts until it's back.${due ? ` ${plural(due, "slot")} past due.` : ""}`;
}

const taskIdOf = (ref) => String(ref).split("/")[0];
const lastAttempt = (run) => run?.attempts?.at(-1) ?? null;

const headerProblem = (st) => (st?.missing ? "agent-tasks not found" : st?.schema != null ? `Unknown schema ${st.schema}` : st?.error ?? null);

// ---------------------------------------------------------------------------
// Herdr: panes, tabs, terminals
// ---------------------------------------------------------------------------

const dashboardPane = (tab) => panes().find((p) => p.tab === tab && p.mod === MOD);

// A space on the machine agent-tasks runs on: the shown one if it is there.
function spaceFor(o) {
  const all = spaces();
  const on = (s) => (s.machine ?? null) === o.machine;
  return (all.find((s) => s.active && on(s)) ?? all.find(on))?.id ?? null;
}

function newTab(o, name, argv) {
  const space = spaceFor(o);
  run("tab.new", { name, argv, ...(space ? { space } : {}) });
}

export function startRunner(o) {
  newTab(o, "agent-tasks runner", ["agent-tasks", "runner"]);
}

// Opens the dashboard beside the focused pane, or focuses it if this tab has
// one. With a run ref, the pane shows that run.
export function showDashboard(o, ref = null) {
  const f = focused();
  if (!f?.tab) return;
  if (ref) setShared(SELECT_KEY, { ref, at: Date.now() });
  const here = dashboardPane(f.tab);
  if (here) return run("pane.focus", { pane: here.pane });
  run("pane.split", { direction: "right", ...(f.pane ? { pane: f.pane } : {}), mod: MOD, props: { view: "dashboard", run: ref, ...(o.fixed ? { machine: o.machine } : {}) } });
}

// `agent-tasks.toggle`: opens the dashboard in the focused tab, or closes it.
export function toggleDashboard(o) {
  const f = focused();
  if (!f?.tab) return;
  const here = dashboardPane(f.tab);
  if (here) return run("pane.close", { pane: here.pane });
  showDashboard(o);
}

// The run's Herdr terminal, if it is still alive: { address, pane } | null.
function liveTerminal(handle) {
  if (!handle) return null;
  const t = terminals().find((x) => (x.address === handle || String(x.address).endsWith(`/${handle}`)) && (x.state ?? "live") === "live");
  if (!t) return null;
  const pane = panes().find((p) => p.terminal === t.address);
  return { address: t.address, pane: pane?.pane ?? null };
}

// ---------------------------------------------------------------------------
// Shared drawing pieces
// ---------------------------------------------------------------------------

const icon = (o, name, size, color) => svg(`${o.dir}/${name}.svg`).size(size).flex_none().text_color(color);
const chevron = (o, open, size, color) => icon(o, open ? "chevron-down" : "chevron-right", size, color);
const dot = (color) => div().size(7).flex_none().rounded(4).bg(color);
const badge = (t, text, color = t.dim, size = 10) => div().flex_none().px(5).rounded(4).bg(t.hover).text_size(size).text_color(color).child(text);

const folds = (key) => shared(key) ?? {};
const isFolded = (key, group) => folds(key)[group] === true;
const flip = (key, group) => setShared(key, { ...folds(key), [group]: !isFolded(key, group) });

function bannerLine(t, b, h, size, id) {
  const color = b.kind === "error" ? t.ansi1 : b.kind === "warn" ? t.ansi3 : t.dim;
  return div().id(id).h(h).px(10).flex().items_center().text_size(size).text_color(color)
    .when(Boolean(b.tip), (el) => el.tooltip(b.tip))
    .child(div().min_w(0).truncate().when(Boolean(b.mono), (el) => el.font_family(MONO)).child(b.text));
}

// ---------------------------------------------------------------------------
// The sidebar panel (a layout block)
// ---------------------------------------------------------------------------

// Fixed sizes, so the block can be sized to the panel exactly.
const HEADER = 26, RUNNER = 22, TODAY = 20, GROUP = 22, ROW = 20, LINE = 20, BUTTON = 26, OPEN = 24, PAD_TOP = 6, PAD_BOTTOM = 4;

const withItems = (dash, items) => GROUPS.map((g) => ({ ...g, items: items(g.id) })).filter((g) => g.items.length > 0);

// The lines of the open panel, each { h, draw(t, o, now) }: the height is
// worked out from the same list that draws it.
function sidebarLines(o, st) {
  const lines = [];
  const dash = st?.dash;
  for (const b of banners(st)) lines.push({ h: LINE, draw: (t, _o, _now, i) => bannerLine(t, b, LINE, 11, `agent-tasks-banner-${i}`) });
  if (!dash) {
    if (!st?.missing && st?.schema == null && !st?.error) lines.push({ h: LINE, draw: (t) => div().h(LINE).px(10).flex().items_center().text_size(11).text_color(t.dim).child("Loading…") });
  } else {
    const dim = Boolean(st.error || st.missing || st.schema != null);
    const wrap = (line) => ({ h: line.h, draw: (...a) => line.draw(...a).when(dim, (el) => el.opacity(0.55)) });
    lines.push(wrap({ h: RUNNER, draw: (t, o, now) => runnerLine(t, dash, now, { h: RUNNER, size: 12 }) }));
    if (stopped(dash)) {
      lines.push(wrap({ h: LINE, draw: (t) => div().h(LINE).px(10).flex().items_center().text_size(11).text_color(t.dim)
        .child(div().min_w(0).truncate().child(stoppedNote(dash))) }));
      lines.push(wrap({ h: BUTTON, draw: (t, o) => runnerButton(t, o, "agent-tasks-start-runner") }));
    }
    lines.push(wrap({ h: TODAY, draw: (t) => todayLine(t, dash, false) }));
    if (isEmpty(dash)) {
      lines.push({ h: LINE, draw: (t) => div().h(LINE).px(10).flex().items_center().text_size(11).text_color(t.dim).child(EMPTY_HINT[0]) });
      lines.push({ h: LINE, draw: (t) => div().h(LINE).px(10).flex().items_center().text_size(11).text_color(t.foreground)
        .child(div().min_w(0).truncate().child(EMPTY_HINT[1])) });
    }
    for (const g of withItems(dash, (id) => dash[id] ?? [])) {
      const open = !isFolded(GROUPS_KEY, g.id);
      lines.push(wrap({ h: GROUP, draw: (t, o) => groupLine(t, o, g, open) }));
      if (!open) continue;
      for (const item of g.items.slice(0, SIDEBAR_ROWS)) lines.push(wrap({ h: ROW, draw: (t, o, now) => sidebarRow(t, o, g.id, item, now) }));
      const more = g.items.length - SIDEBAR_ROWS;
      if (more > 0) lines.push(wrap({ h: ROW, draw: (t, o) => h_flex().id(`agent-tasks-more-${g.id}`).h(ROW).px(10).pl(27).items_center().rounded(6).cursor_pointer()
        .text_size(10.5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => showDashboard(o))
        .child(`+${more} more in the dashboard`) }));
    }
  }
  lines.push({ h: OPEN, draw: (t, o) => h_flex().id("agent-tasks-open").h(OPEN).px(10).gap(7).items_center().rounded(6).cursor_pointer()
    .text_size(11).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click(() => showDashboard(o))
    .child(icon(o, "panel-right", 12, t.dim))
    .child(div().child("Open dashboard")) });
  return lines;
}

export function panelHeight(o) {
  if (shared(FOLDED_KEY) === true) return PAD_TOP + HEADER;
  return PAD_TOP + HEADER + 1 + sidebarLines(o, snapshot(o)).reduce((h, l) => h + l.h, 0) + PAD_BOTTOM;
}

function runnerLine(t, dash, now, { h, size }) {
  const r = dash.runner ?? {};
  const healthy = r.state === "healthy";
  const last = parse(r.last_tick);
  const next = parse(r.next_tick);
  const tip = last ? `Last tick ${formatWhen(last, now)}:${pad2(new Date(last).getSeconds())}` : "The runner has never ticked";
  const right = healthy ? (next ? `next ${clock(next)}` : "") : last ? `${span(now - last)} ago` : "never ran";
  return h_flex().id("agent-tasks-runner").h(h).px(10).gap(7).items_center().tooltip(tip)
    .child(dot(healthy ? t.ansi2 : t.ansi1))
    .child(div().text_size(size).text_color(t.foreground).child("Runner"))
    .child(badge(t, healthy ? `every ${r.every ?? "?"}` : "stopped", healthy ? t.dim : t.ansi1))
    .child(div().flex_1())
    .child(div().flex_none().text_size(10.5).text_color(healthy ? t.dim : t.ansi1).child(right));
}

function runnerButton(t, o, id) {
  return h_flex().h(BUTTON).px(10).items_center()
    .child(h_flex().id(id).h(22).px(8).gap(6).items_center().rounded(6).border(1).border_color(t.border).cursor_pointer()
      .text_size(11).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_click(() => startRunner(o))
      .child(icon(o, "terminal", 11, t.dim))
      .child(div().child("Start runner in a new tab")));
}

// `■ 3  × 1  □ 0  ! 0`; `wide` spells them out (`3 ok`, `1 failed`).
function todayLine(t, dash, wide) {
  const d = dash.today ?? {};
  const item = (glyph, n, word, color) => h_flex().gap(4).items_center().text_color(n > 0 ? color : t.dim)
    .child(div().child(glyph)).child(div().child(wide ? `${n} ${word}` : String(n ?? 0)));
  return h_flex().h(wide ? 22 : TODAY).px(10).gap(wide ? 12 : 10).items_center().text_size(11)
    .child(div().w(44).flex_none().text_color(t.dim).child("Today"))
    .child(item("■", d.succeeded ?? 0, "ok", t.ansi2))
    .child(item("×", d.failed ?? 0, "failed", t.ansi1))
    .child(item("□", d.missed ?? 0, "missed", t.dim))
    .child(item("!", d.blocked ?? 0, "blocked", t.ansi3));
}

function groupLine(t, o, g, open) {
  return h_flex().id(`agent-tasks-group-${g.id}`).h(GROUP).px(10).gap(6).items_center().rounded(6).cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click(() => flip(GROUPS_KEY, g.id))
    .child(div().text_size(12).text_color(t.foreground).child(g.name))
    .child(badge(t, String(g.items.length)))
    .child(div().flex_1())
    .child(chevron(o, open, 10, t.dim));
}

// What a row shows on its right: elapsed, `in 23h`, `paused` or `14:05`.
function rowRight(t, group, item, now) {
  if (group === "running") {
    const start = parse(item.started_at) ?? parse(item.slot);
    // Minutes: the list redraws once a minute.
    const elapsed = start ? (now - start < MINUTE ? "<1m" : span(now - start)) : "";
    return { text: item.status === "blocked" ? "blocked" : elapsed, color: item.status === "blocked" ? t.ansi3 : t.ansi4 };
  }
  if (group === "next") return { text: item.state === "paused" ? "paused" : inTime((parse(item.at) ?? now) - now), color: t.dim };
  return { text: shortWhen(parse(item.at) ?? now, now), color: t.dim };
}

const rowMark = (t, group, item) => mark(t, group === "next" ? (item.state === "paused" ? "paused" : "next") : item.status);

function rowTip(group, item) {
  if (group === "next") return `${item.title} · ${item.schedule}`;
  if (group === "recent") return item.summary || item.reason || statusWord(item.status);
  return `${item.ref} · ${statusWord(item.status)}`;
}

function sidebarRow(t, o, group, item, now) {
  const m = rowMark(t, group, item);
  const right = rowRight(t, group, item, now);
  const ref = group === "next" ? null : item.ref;
  return h_flex().id(`agent-tasks-row-${group}-${item.ref ?? item.task_id}`).h(ROW).px(10).gap(7).items_center().rounded(6).text_size(11)
    .tooltip(rowTip(group, item))
    .when(Boolean(ref), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => showDashboard(o, ref)))
    .child(div().w(10).flex_none().text_color(m.color).child(m.glyph))
    .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(item.task_id))
    .child(div().flex_none().text_size(10.5).text_color(right.color).child(right.text));
}

// The sidebar panel: a header that folds it, then the runner, today's results
// and the Running / Next / Recent groups.
export function tasksPanel(t, o) {
  const now = Date.now();
  const folded = shared(FOLDED_KEY) === true;
  const st = snapshot(o);
  const problem = headerProblem(st);
  const showDot = st?.dash && ((folded && needsAttention(st.dash)) || stopped(st.dash));
  return v_flex().flex_none().px(8).pt(PAD_TOP).gap(0)
    .child(h_flex().id("agent-tasks-toggle").h(HEADER).px(10).gap(8).items_center().rounded(8).cursor_pointer().text_size(11.5).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => setShared(FOLDED_KEY, !folded))
      .child(div().flex_1().min_w(0).truncate().child("Agent tasks"))
      .when(Boolean(problem), (el) => el.child(div().id("agent-tasks-problem").text_size(11).font_bold().text_color(t.dim).tooltip(problem).child("!")))
      .when(Boolean(showDot), (el) => el.child(div().mx(3).child(dot(t.ansi1))))
      .child(chevron(o, !folded, 11, t.dim)))
    .when(!folded, (el) => el.child(v_flex().pt(1).pb(PAD_BOTTOM)
      .children(sidebarLines(o, st).map((l, i) => l.draw(t, o, now, i)))));
}

// ---------------------------------------------------------------------------
// The dashboard pane
// ---------------------------------------------------------------------------

// The run detail's sections, like `agent-tasks top` (src/tui/detail.ts):
// Result and Output open when there is a result; Log open when there isn't.
function sectionsOf(detail, dash, now) {
  const { log, run, task, output, dataDir } = detail;
  const last = lastAttempt(run);
  const inProgress = IN_PROGRESS.includes(run.status);
  const neverStarted = !run.attempts?.length || run.status === "missed";
  const started = parse(last?.started_at);
  const finished = parse(last?.finished_at);
  const took = started ? (finished ?? now) - started : null;
  const sections = [];

  const facts = [
    `${statusWord(run.status)}${run.reason ? ` (${run.reason})` : ""}`,
    `slot ${formatWhen(parse(run.slot) ?? now, now)}`,
    ...(took !== null ? [`${inProgress ? "running for" : "took"} ${span(took)}`] : []),
    ...(run.attempts?.length > 1 ? [`attempt ${run.attempts.length}`] : []),
  ].join(" · ");
  const summary = last?.summary;
  const hasResult = Boolean(summary || last?.output);
  let note = null;
  if (!summary) {
    if (neverStarted) note = "It never started, so there is no output or log.";
    else note = `${inProgress ? "Still in progress: the agent reports its result when it finishes." : "The agent reported no summary."}${log ? " Its log is below." : ""}`;
  }
  sections.push({ id: "result", name: "Result", extra: "", kind: "text", facts, text: summary ?? null, note, open: true });

  if (last?.output) {
    sections.push({ id: "output", name: "Output", extra: output?.path ?? last.output, kind: "text",
      text: output?.text ?? null, note: output ? (output.text === null ? "(the file is gone)" : null) : "Reading…", open: true });
  }

  const nextInfo = findTask(dash, run.task_id);
  const rows = [
    ["Task", task ? `${task.id} — ${task.title}` : `${run.task_id} (${detail.taskError ? `couldn't read it: ${detail.taskError}` : "removed"})`],
    ...(task ? [["Folder", task.cwd], ["Schedule", nextInfo?.schedule ?? scheduleText(task.schedule)]] : []),
    ["Slot", formatWhen(parse(run.slot) ?? now, now)],
    ...(last ? [["Attempts", `${run.attempts.length}${task ? ` of ${(detail.retries ?? task.retries ?? 0) + 1}` : ""}`]] : []),
    ["Run ref", detail.ref],
  ];
  sections.push({ id: "details", name: "Details", extra: task ? `${task.title} · ${task.cwd}` : `${run.task_id} (${detail.taskError ? "couldn't read the task" : "removed"})`, kind: "mono",
    lines: rows.map(([k, v]) => `${k.padEnd(9)} ${v}`), open: false });

  if (run.attempts?.length) {
    const lines = [];
    run.attempts.forEach((a, i) => {
      if (i > 0) lines.push("");
      lines.push(...attemptLines(a, run, now, dataDir));
    });
    sections.push({ id: "attempts", name: "Attempts", extra: plural(run.attempts.length, "attempt"), kind: "mono", lines, open: false });
  }

  const events = run.events ?? [];
  const lastEvent = events.at(-1);
  sections.push({ id: "events", name: "Events", extra: lastEvent ? `${plural(events.length, "event")} · last: ${lastEvent.event}` : "none", kind: "mono",
    lines: events.map((e) => `${eventTime(e.at, run, now)}  ${String(e.event).padEnd(16)} ${pairs(e, ["at", "event"])}`), open: false });

  if (log) {
    let lines, extra = log.path;
    if (!log.exists || log.content == null) lines = [inProgress ? "(not captured yet: it is still in progress)" : "(nothing captured)"];
    else {
      const all = clean(log.content).trimEnd().split("\n");
      if (!all.join("").trim()) lines = ["(empty)"];
      else {
        lines = all.length > LOG_LINES ? [`(only the last ${LOG_LINES} of ${all.length} lines)`, ...all.slice(-LOG_LINES)] : all;
        extra = `${plural(all.length, "line")} · ${log.path}`;
      }
    }
    sections.push({ id: "log", name: "Log", extra, kind: "mono", lines, open: !hasResult && !neverStarted });
  }
  return sections;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function scheduleText(s) {
  if (!s) return "—";
  if (s.type === "cron") return s.cron;
  if (s.type === "once") return `once ${s.at ?? ""}`.trim();
  return Object.entries(s).filter(([k, v]) => k !== "timezone" && v != null).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
}

// Terminal escapes and other control characters out; tabs to spaces.
function clean(text) {
  return String(text ?? "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function pairs(record, skip = []) {
  return Object.entries(record)
    .filter(([k, v]) => !skip.includes(k) && v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}

function eventTime(at, run, now) {
  const ms = parse(at);
  if (ms === null) return String(at ?? "");
  const slot = parse(run.slot);
  return slot !== null && sameDay(ms, slot) ? clock(ms, true) : `${formatWhen(ms, now)}:${pad2(new Date(ms).getSeconds())}`;
}

const absolute = (path, dir) => (!path || path.startsWith("/") || !dir ? path : `${dir.replace(/\/$/, "")}/${path}`);

function attemptLines(a, run, now, dir) {
  const start = parse(a.started_at);
  const end = parse(a.finished_at);
  const duration = start ? span((end ?? now) - start) : "?";
  const agent = a.agent ? [a.agent.command, ...(Array.isArray(a.agent.args) ? a.agent.args : [])].filter((x) => x != null).join(" ") || "?" : "—";
  const session = a.session ? `${a.session.launcher || "?"}${pairs(a.session, ["launcher"]) ? ` · ${pairs(a.session, ["launcher"])}` : ""}` : "—";
  const rows = [
    ["agent", agent],
    ["launcher", session],
    ["summary", a.summary ?? "—"],
    ...(a.reason ? [["reason", a.reason]] : []),
    ...(a.output ? [["output", absolute(a.output, dir)]] : []),
    ...(a.log ? [["log", absolute(a.log, dir)]] : []),
  ];
  return [
    `Attempt ${a.n} · ${statusWord(a.status)} · started ${start ? eventTime(a.started_at, run, now) : "?"} · ${end ? duration : `${duration} so far`}`,
    ...rows.map(([k, v]) => `  ${k.padEnd(9)} ${v}`),
  ];
}

// The data folder, for relative paths in a run: the snapshot's `data_dir`,
// else what the log's absolute path says, else the default (this computer).
function runDataDir(o, run, log) {
  const fromSnapshot = snapshot(o)?.dash?.data_dir;
  if (fromSnapshot) return fromSnapshot;
  const rel = run.attempts?.find((a) => a.n === log?.attempt)?.log;
  if (log?.path && rel && !rel.startsWith("/") && log.path.endsWith(`/${rel}`)) return log.path.slice(0, -rel.length - 1);
  return dataDir(o);
}

// One copy of the dashboard pane: its selection, the selected run's detail,
// folded sections and the last action.
export class Dashboard {
  constructor(o, initialRef) {
    this.o = o;
    this.sel = initialRef ? { kind: "run", id: initialRef } : null;
    this.seenSelect = Number(shared(SELECT_KEY)?.at) || 0;
    this.detail = null; // { ref, key, run, log, task, retries, output, dataDir, error, loading }
    this.folds = {}; // section id -> open
    this.action = null; // { command, state: "running" | "done" | "error", message }
    this.loading = null; // key being read
  }

  // The sidebar asked for a run (SELECT_KEY): take it.
  takeSelection() {
    const s = shared(SELECT_KEY);
    if (!s?.ref || Number(s.at) <= this.seenSelect) return false;
    this.seenSelect = Number(s.at);
    this.select({ kind: "run", id: s.ref });
    return true;
  }

  select(sel) {
    if (this.sel?.kind === sel.kind && this.sel?.id === sel.id) return;
    this.sel = sel;
    this.folds = {};
  }

  // The selection, or the first run in progress, else the latest result.
  current(dash) {
    if (this.sel) return this.sel;
    const first = dash?.running?.[0] ?? dash?.recent?.[0];
    if (first) return { kind: "run", id: first.ref };
    const task = dash?.next?.[0];
    return task ? { kind: "task", id: task.task_id } : null;
  }

  // Reads the selected run again when it changed in the snapshot (or every
  // minute while it is in progress).
  sync(cx, dash) {
    const sel = this.current(dash);
    if (sel?.kind !== "run") return;
    const row = findRun(dash, sel.id);
    const tick = row && IN_PROGRESS.includes(row.status) ? Math.floor(Date.now() / MINUTE) : 0;
    const key = `${sel.id}|${row ? `${row.status}|${row.at}|${row.attempt}` : "?"}|${tick}`;
    if (this.detail?.key === key || this.loading === key) return;
    this.loading = key;
    cx.spawn(async (cx) => {
      try {
        await this.load(cx, sel.id, key);
      } catch (e) {
        if (this.loading === key) this.detail = { ref: sel.id, key, error: String(e?.message ?? e) };
      } finally {
        if (this.loading === key) this.loading = null;
      }
      cx.notify();
    });
  }

  async load(cx, ref, key) {
    // The task (title, folder, retries) changes rarely: read once per run shown.
    const prev = this.detail?.ref === ref && this.detail?.run ? this.detail : null;
    const [log, show] = await Promise.all([cli(this.o, ["log", ref]), prev ? null : cli(this.o, ["show", taskIdOf(ref)])]);
    if (this.loading !== key) return;
    if (log.error || log.missing) {
      this.detail = { ref, key, error: log.error ?? "agent-tasks not found" };
      return;
    }
    const runData = log.json?.run;
    if (!runData) throw new Error("agent-tasks log printed no run");
    // `show` failing for another reason than a removed task isn't a removed task.
    const showError = show?.error && !/not found/i.test(show.error) ? show.error : null;
    const task = show ? show.json?.task ?? null : prev.task;
    const retries = show ? show.json?.resolved?.retries ?? null : prev.retries;
    const taskState = show ? show.json?.state ?? null : prev.taskState;
    const taskError = show ? showError : prev.taskError;
    const dir = runDataDir(this.o, runData, log.json.log);
    const output = lastAttempt(runData)?.output;
    this.detail = { ref: log.json.ref ?? ref, key, run: runData, log: log.json.log, task, retries, taskState, taskError, dataDir: dir, output: null };
    if (!output) return;
    cx.notify();
    const path = absolute(output, dir);
    let text = null;
    try {
      text = path ? await readTextFile(path, onMachine(this.o)) : null;
    } catch {
      // Unreadable: shown as gone.
    }
    if (this.detail?.key !== key) return;
    this.detail = { ...this.detail, output: { path, text: text === null ? null : clean(text) } };
  }

  // Runs one CLI action, shows it in the strip, then reads everything again.
  act(cx, args, refresh) {
    const command = `agent-tasks ${args.join(" ")}`;
    this.action = { command, state: "running", message: null };
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await cli(this.o, args);
      this.action = r.error || r.missing
        ? { command, state: "error", message: r.error ?? "agent-tasks not found" }
        : { command, state: "done", message: null };
      this.detail = this.detail ? { ...this.detail, key: null } : null;
      refresh?.(cx);
      cx.notify();
    });
  }

  // Terminal: the run's live Herdr terminal, else `agent-tasks attach` in a new tab.
  terminal(runData) {
    const last = lastAttempt(runData);
    const live = last?.session?.launcher === "herdr" ? liveTerminal(last.session.handle) : null;
    if (live?.pane) return run("pane.focus", { pane: live.pane });
    if (live) return run("terminal.peek", { terminal: live.address });
    newTab(this.o, `attach ${runData.task_id}`, ["agent-tasks", "attach", this.detail.ref]);
  }

  // Keys (Vim style, like `agent-tasks top`): j/k move, a r R p act.
  key(event, cx, refresh) {
    const dash = snapshot(this.o)?.dash;
    if (!dash) return;
    const list = paneItems(dash).filter((x) => !isFolded(PANE_GROUPS_KEY, x.group));
    const sel = this.current(dash);
    const i = list.findIndex((x) => x.sel.kind === sel?.kind && x.sel.id === sel?.id);
    const k = event.keystroke;
    if (/(^|-)(cmd|ctrl|alt)-/.test(k)) return;
    if (k === "j" || k === "down") return this.moveTo(list[Math.min(list.length - 1, i + 1)], cx);
    if (k === "k" || k === "up") return this.moveTo(list[Math.max(0, i - 1)], cx);
    if (k === "g") return this.moveTo(list[0], cx);
    if (k === "shift-g") return this.moveTo(list.at(-1), cx);
    const actions = this.actions(dash, sel);
    const hit = actions.find((a) => a.key === (event.key_char ?? k));
    if (hit) this.press(hit, cx, refresh);
  }

  // Retry and Run now start an agent: the first press asks, the second runs.
  press(a, cx, refresh) {
    if (!a.enabled) return;
    if (a.confirm && this.confirming !== a.id) {
      this.confirming = a.id;
      cx.notify();
      cx.timer.after(4000, (cx) => {
        if (this.confirming !== a.id) return;
        this.confirming = null;
        cx.notify();
      });
      return;
    }
    this.confirming = null;
    a.run(cx, refresh);
  }

  moveTo(item, cx) {
    if (!item) return;
    this.select(item.sel);
    this.syncNow(cx);
  }

  // After a selection: read the run without waiting for the timer.
  syncNow(cx) {
    const dash = snapshot(this.o)?.dash;
    if (dash) this.sync(cx, dash);
    cx.notify();
  }

  // The buttons above a run (or a task):
  // { id, label, icon, key, enabled, why (when not), confirm, run }.
  actions(dash, sel) {
    if (!sel) return [];
    const taskId = sel.kind === "run" ? taskIdOf(sel.id) : sel.id;
    const detail = sel.kind === "run" && this.detail?.ref === sel.id ? this.detail : null;
    const runData = detail?.run ?? null;
    // A task in Next, else what `show` said about the run's task (finished
    // one-off tasks aren't in Next).
    const state = findTask(dash, taskId)?.state ?? detail?.taskState ?? null;
    const paused = state === "paused";
    const live = state === "active" || paused;
    const row = sel.kind === "run" ? findRun(dash, sel.id) : null;
    const status = runData?.status ?? row?.status;
    const session = lastAttempt(runData)?.session;
    const noTask = state === "archived" ? "The task is archived" : "The task is gone";
    const list = [];
    if (sel.kind === "run") {
      list.push({ id: "terminal", label: "Terminal", icon: "terminal", key: "a",
        enabled: Boolean(runData && (IN_PROGRESS.includes(status) || (session && !session.closed_at))),
        why: "Its session is closed: read its log below",
        run: () => this.terminal(runData) });
      list.push({ id: "retry", label: "Retry", icon: "rotate-ccw", key: "r", enabled: RETRYABLE.includes(status), confirm: true,
        why: "Only failed, timed-out and missed runs can be retried",
        run: (cx, refresh) => this.act(cx, ["retry", sel.id], refresh) });
    }
    list.push({ id: "run-now", label: "Run now", icon: "play", key: "R", enabled: Boolean(state) && state !== "archived", confirm: true,
      why: noTask, run: (cx, refresh) => this.act(cx, ["run", taskId], refresh) });
    list.push({ id: "pause", label: paused ? "Resume" : "Pause", icon: paused ? "play" : "pause", key: "p", enabled: live,
      why: noTask, run: (cx, refresh) => this.act(cx, [paused ? "resume" : "pause", taskId], refresh) });
    return list.map((a) => (this.confirming === a.id ? { ...a, label: `Confirm ${a.label.toLowerCase()}` } : a));
  }
}

// The left column's rows, in order: { group, item, sel }.
function paneItems(dash) {
  return [
    ...(dash.running ?? []).map((item) => ({ group: "running", item, sel: { kind: "run", id: item.ref } })),
    ...(dash.next ?? []).map((item) => ({ group: "next", item, sel: { kind: "task", id: item.task_id } })),
    ...(dash.recent ?? []).map((item) => ({ group: "recent", item, sel: { kind: "run", id: item.ref } })),
  ];
}

const LEFT_W = 380;

function paneGroupHeader(t, o, id, name, count, open) {
  return h_flex().id(`agent-tasks-pane-group-${id}`).h(26).px(10).gap(6).items_center().rounded(6).cursor_pointer()
    .text_size(11.5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click(() => flip(PANE_GROUPS_KEY, id))
    .child(div().child(name))
    .child(badge(t, String(count)))
    .child(div().flex_1())
    .child(chevron(o, open, 10, t.dim));
}

function paneRow(t, view, entry, selected, now) {
  const { group, item, sel } = entry;
  const m = rowMark(t, group, item);
  const right = rowRight(t, group, item, now);
  return h_flex().id(`agent-tasks-pane-row-${group}-${sel.id}`).h(22).px(10).gap(8).items_center().rounded(6).cursor_pointer().text_size(12)
    .when(selected, (el) => el.bg(t.hover))
    .hover((s) => s.bg(t.hover))
    .tooltip(rowTip(group, item))
    .on_click((_e, cx) => {
      view.select(sel);
      view.syncNow(cx);
    })
    .child(div().w(12).flex_none().text_color(m.color).child(m.glyph))
    .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(item.task_id))
    .when(Boolean(item.machine), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(item.machine)))
    .child(div().w(52).flex_none().flex().justify_end().text_size(10.5).text_color(right.color).child(right.text));
}

// `14:21:20  ● stopped · …` -> { time, glyph, text }.
function eventParts(line) {
  const m = /^(\d\d:\d\d(?::\d\d)?)\s+(.*)$/.exec(line);
  const time = m ? m[1] : "";
  const rest = (m ? m[2] : line).trim();
  const g = /^([■✕×□!▶↻●◐])\s+(.*)$/.exec(rest);
  const text = (g ? g[2] : rest).replace(/\s{2,}/g, " ");
  return { time, glyph: g ? g[1] : "", text };
}

function eventColor(t, glyph, text) {
  if (glyph === "■") return t.ansi2;
  if (glyph === "✕" || glyph === "×") return t.ansi1;
  if (glyph === "!") return t.ansi3;
  if (glyph === "▶" || glyph === "◐") return t.ansi4;
  if (glyph === "●") return /stopped/.test(text) ? t.ansi1 : t.ansi2;
  return t.dim;
}

function eventsList(t, o, dash) {
  const open = !isFolded(PANE_GROUPS_KEY, "events");
  const lines = (dash.events ?? []).slice(-60).reverse();
  return v_flex().flex_none().border_t(1).border_color(t.border).pt(4).pb(6).px(6)
    .child(h_flex().id("agent-tasks-pane-group-events").h(26).px(10).gap(6).items_center().rounded(6).cursor_pointer()
      .text_size(11.5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => flip(PANE_GROUPS_KEY, "events"))
      .child(div().child("Events"))
      .child(div().child("· runner.log"))
      .child(div().flex_1())
      .child(chevron(o, open, 10, t.dim)))
    .when(open, (el) => el.child(v_flex().max_h(220).overflow_y_scrollbar()
      .children(lines.map((line, i) => {
        const e = eventParts(line);
        return h_flex().id(`agent-tasks-event-${i}`).h(20).px(10).gap(8).items_center().text_size(11).tooltip(line)
          .child(div().w(52).flex_none().text_color(t.dim).child(e.time))
          .child(div().w(10).flex_none().text_color(eventColor(t, e.glyph, e.text)).child(e.glyph))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(e.text));
      }))));
}

function leftColumn(t, view, st, now) {
  const o = view.o;
  const dash = st?.dash;
  const dim = Boolean(st?.error || st?.missing || st?.schema != null);
  const problem = headerProblem(st);
  const sel = dash ? view.current(dash) : null;
  const col = v_flex().w(LEFT_W).flex_none().h_full().min_h(0).border_r(1).border_color(t.border)
    .child(h_flex().flex_none().h(36).px(16).gap(8).items_center()
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("agent-tasks top"))
      .child(div().flex_1())
      .when(Boolean(problem), (el) => el.child(div().id("agent-tasks-pane-problem").text_size(12).font_bold().text_color(t.dim).tooltip(problem).child("!"))))
    .children(banners(st).map((b, i) => div().px(6).child(bannerLine(t, b, 22, 11.5, `agent-tasks-pane-banner-${i}`))));
  if (!dash) {
    return col.when(!st?.missing && st?.schema == null && !st?.error, (el) => el.child(div().px(16).py(6).text_size(12).text_color(t.dim).child("Loading…")));
  }
  const items = paneItems(dash);
  const groups = withItems(dash, (id) => items.filter((x) => x.group === id));
  return col
    .child(v_flex().flex_none().px(6).when(dim, (el) => el.opacity(0.55))
      .child(runnerLine(t, dash, now, { h: 26, size: 12.5 }))
      .when(stopped(dash), (el) => el
        .child(div().px(10).py(3).text_size(11.5).text_color(t.dim)
          .child(stoppedNote(dash)))
        .child(runnerButton(t, o, "agent-tasks-pane-start-runner")))
      .child(todayLine(t, dash, true)))
    .child(v_flex().flex_1().min_h(0).px(6).pt(4).pb(8).overflow_y_scrollbar().when(dim, (el) => el.opacity(0.55))
      .when(isEmpty(dash), (el) => el
        .child(div().px(10).pt(6).text_size(12).text_color(t.dim).child(EMPTY_HINT[0]))
        .child(div().px(10).pt(2).text_size(12).text_color(t.foreground).child(EMPTY_HINT[1])))
      .children(groups.map((g) => {
        const open = !isFolded(PANE_GROUPS_KEY, g.id);
        return v_flex()
          .child(paneGroupHeader(t, o, g.id, g.name, g.items.length, open))
          .when(open, (el) => el.children(g.items.map((x) => paneRow(t, view, x, sel?.kind === x.sel.kind && sel?.id === x.sel.id, now))));
      })))
    .child(eventsList(t, o, dash));
}

function actionButton(t, view, a, refresh) {
  const asking = view.confirming === a.id;
  return h_flex().id(`agent-tasks-action-${a.id}`).h(26).px(8).gap(6).items_center().rounded(6).text_size(11.5)
    .text_color(asking ? t.ansi3 : t.dim).when(!a.enabled, (el) => el.opacity(0.4).tooltip(a.why))
    .when(a.enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => view.press(a, cx, refresh)))
    .child(icon(view.o, a.icon, 12, asking ? t.ansi3 : t.dim))
    .child(div().child(a.label))
    .child(div().px(4).rounded(3).border(1).border_color(t.border).text_size(10).font_family(MONO).text_color(t.dim).child(a.key));
}

function sectionView(t, o, view, s) {
  const open = view.folds[s.id] ?? s.open;
  const header = h_flex().id(`agent-tasks-section-${s.id}`).h(26).px(10).gap(8).items_center().rounded(6).cursor_pointer()
    .hover((st) => st.bg(t.hover))
    .on_click((_e, cx) => {
      view.folds[s.id] = !open;
      cx.notify();
    })
    .child(div().flex_none().text_size(12.5).font_medium().text_color(t.foreground).child(s.name))
    .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(s.extra))
    .child(chevron(o, open, 11, t.dim));
  if (!open) return header;
  let body;
  if (s.kind === "text") {
    body = v_flex().px(10).pt(2).pb(8).gap(6)
      .when(Boolean(s.facts), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(s.facts)))
      .when(s.text != null, (el) => el.children(clean(s.text).split("\n").map((l) => div().text_size(13).text_color(t.foreground).child(l || " "))))
      .when(Boolean(s.note), (el) => el.child(div().text_size(12.5).text_color(t.dim).child(s.note)));
  } else {
    body = div().px(10).pt(2).pb(8).child(v_flex().p(10).rounded(6).bg(t.raised ?? t.hover).font_family(MONO).text_size(11.5).text_color(t.foreground)
      .children(s.lines.map((l) => div().child(l || " "))));
  }
  return v_flex().child(header).child(body);
}

function rightColumn(t, view, st, now, refresh) {
  const o = view.o;
  const dash = st?.dash;
  const sel = dash ? view.current(dash) : null;
  const empty = (text) => v_flex().flex_1().min_w(0).p(24).text_size(12.5).text_color(t.dim).child(text);
  if (!dash) return empty("");
  if (!sel) return empty("Nothing to show yet.");
  const actions = view.actions(dash, sel);
  const buttons = h_flex().flex_none().gap(2).items_center().children(actions.map((a) => actionButton(t, view, a, refresh)));
  let head, meta, sections = [];
  if (sel.kind === "task") {
    const task = findTask(dash, sel.id);
    const m = mark(t, task?.state === "paused" ? "paused" : "next");
    head = [m, sel.id, task?.state === "paused" ? "paused" : "next", t.dim];
    meta = task ? [task.title, task.schedule, task.at ? `next ${formatWhen(parse(task.at), now)}` : "paused", task.machine].filter(Boolean).join(" · ") : "";
  } else {
    const d = view.detail?.ref === sel.id ? view.detail : null;
    const row = findRun(dash, sel.id);
    const status = d?.run?.status ?? row?.status ?? "?";
    const m = mark(t, status);
    head = [m, taskIdOf(sel.id), statusWord(status), m.color];
    const last = lastAttempt(d?.run);
    const started = parse(last?.started_at ?? row?.started_at);
    const finished = parse(last?.finished_at ?? row?.finished_at);
    const n = d?.run?.attempts?.length ?? row?.attempt ?? 0;
    const max = d?.retries != null ? d.retries + 1 : d?.task?.retries != null ? d.task.retries + 1 : null;
    const session = last?.session;
    meta = [
      started ? `Started ${formatWhen(started, now)}` : `Slot ${formatWhen(parse(row?.slot ?? d?.run?.slot) ?? now, now)}`,
      started ? span((finished ?? now) - started) : null,
      n ? `attempt ${n}${max ? `/${Math.max(max, n)}` : ""}` : null,
      row?.machine ?? null,
      session ? `${session.launcher}${session.handle ? ` ${session.handle}` : ""}` : row?.handle ? `handle ${row.handle}` : null,
    ].filter(Boolean).join(" · ");
    if (d?.error) sections = [div().px(10).py(6).text_size(12).text_color(t.ansi3).child(`Couldn't read the run: ${d.error}`)];
    else if (!d?.run) sections = [div().px(10).py(6).text_size(12).text_color(t.dim).child("Loading…")];
    else sections = sectionsOf(d, dash, now).map((s) => sectionView(t, o, view, s));
  }
  const [m, title, word, color] = head;
  const strip = view.action;
  return v_flex().flex_1().min_w(0).h_full().min_h(0)
    .child(v_flex().flex_none().px(20).pt(12).pb(10).gap(4)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_none().text_size(14).text_color(m.color).child(m.glyph))
        .child(div().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(title))
        .child(div().flex_none().px(6).rounded(4).bg(t.hover).text_size(10.5).text_color(color).child(word))
        .child(div().flex_1())
        .child(buttons))
      .child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(meta)))
    .child(v_flex().flex_1().min_h(0).px(10).pb(12).gap(2).overflow_y_scrollbar().children(sections))
    .when(Boolean(strip), (el) => el.child(h_flex().flex_none().h(28).px(20).gap(8).items_center().border_t(1).border_color(t.border).text_size(11.5)
      .child(div().flex_none().font_family(MONO).text_color(t.dim).child(strip.command))
      .child(div().flex_1().min_w(0).truncate().text_color(strip.state === "error" ? t.ansi1 : strip.state === "running" ? t.dim : t.ansi2)
        .when(Boolean(strip.message), (el) => el.tooltip(strip.message))
        .child(strip.state === "running" ? "running…" : strip.state === "error" ? strip.message : "done"))));
}

// The dashboard pane: the lists on the left, the selected run on the right.
// Keeps a pane's selected run read: now, and twice a second (cheap: it only
// reads the CLI when the run changed in the snapshot or was selected).
export function startDashboard(cx, view) {
  const step = (cx) => {
    if (!view.o.known) return;
    const dash = snapshot(view.o)?.dash;
    if (view.takeSelection()) cx.notify();
    if (dash) view.sync(cx, dash);
  };
  step(cx);
  cx.timer.every(500, step);
}

export function dashboardPaneView(t, view, refresh) {
  const now = Date.now();
  const st = snapshot(view.o);
  return h_flex().size_full().min_h(0).text_color(t.foreground)
    .child(leftColumn(t, view, st, now))
    .child(rightColumn(t, view, st, now, refresh));
}
