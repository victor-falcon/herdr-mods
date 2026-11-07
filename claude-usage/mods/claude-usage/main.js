// Claude usage: a foldable panel with the subscription limits of one or more
// Claude accounts (5-hour session, weekly, per-model weekly). Folded, a red dot
// says some limit is at 75% or more. The drawing and fetching live in panel.js.
//
// props: { block, accounts: [{ name, config }], warn, lang }
//   block     the id of the layout block showing this mod: it is resized to the
//             panel's height, so folding it gives the room back.
//   accounts  each one's CLAUDE_CONFIG_DIR ("~/.claude-work"); left out: ~/.claude.

import { View, div } from "gpui-kit";
import { props, theme, layout, run } from "herdr";
import { usageOptions, usagePanel, panelHeight, startUsage } from "./panel.js";

const DIR = "mods/claude-usage";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class ClaudeUsage extends View {
  init(_props, cx) {
    startUsage(cx, () => usageOptions(props(), DIR));
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
    const o = usageOptions(props(), DIR);
    this.fit(o);
    return div().size_full().overflow_hidden().child(usagePanel(theme(), o));
  }
}
