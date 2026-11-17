// agent-tasks: a Herdr view of `agent-tasks top`. As a layout block, a small
// foldable panel with the runner, today's results and the Running / Next /
// Recent runs; as a pane (props.view = "dashboard"), the whole dashboard with
// the selected run's result, log and actions. The drawing and fetching live
// in panel.js.
//
// props: { block, machine, view, run }
//   block    the id of the layout block showing this mod: it is resized to the
//            panel's height, so folding it gives the room back.
//   machine  the Herdr machine agent-tasks runs on (a space's `machine`);
//            left out, this computer.
//   view     "dashboard" for the pane; run: the run ref it opens on.
//
// Command `agent-tasks.toggle` (handled by the block): opens the dashboard in
// the focused tab, or closes it if that tab has one.

import { View, div } from "gpui-kit";
import { props, theme, layout, run, nextCommand } from "herdr";
import { tasksOptions, tasksPanel, panelHeight, startTasks, toggleDashboard, Dashboard, startDashboard, dashboardPaneView } from "./panel.js";

const DIR = "mods/agent-tasks";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const options = () => tasksOptions(props(), DIR);
const isPane = () => props()?.view === "dashboard";

export default class AgentTasks extends View {
  init(_props, cx) {
    this.tasks = startTasks(cx, options);
    if (isPane()) {
      this.dashboard = new Dashboard(options(), props()?.run ?? null);
      startDashboard(cx, this.dashboard);
      this.handle = cx.focus_handle();
      // Take the keyboard when it opens, so j/k and the action keys work.
      cx.timer.after(50, () => this.handle.focus());
      return;
    }
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        if (command === "toggle") toggleDashboard(options());
      }
    });
  }

  // Keeps the block as tall as the panel. Only when it differs, so no loop.
  fit(o) {
    const id = props()?.block;
    if (!id) return;
    const px = panelHeight(o);
    const node = find(layout(), id);
    if (node && node.size?.px !== px) run("layout.resize", { id, px });
  }

  render() {
    const t = theme();
    if (isPane()) {
      const view = this.dashboard;
      view.o = options();
      return div().size_full().overflow_hidden().text_size(13).bg(t.background)
        .track_focus(this.handle)
        .on_mouse_down("left", () => this.handle.focus())
        .on_key_down((event, cx) => view.key(event, cx, this.tasks.refresh))
        .child(dashboardPaneView(t, view, this.tasks.refresh));
    }
    const o = options();
    this.fit(o);
    return div().size_full().overflow_hidden().child(tasksPanel(t, o));
  }
}
