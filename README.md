# herdr-mods

Mods for the [Herdr](https://herdr.dev) app.

| Mod | What it does |
|-----|--------------|
| [agent-tasks](agent-tasks/) | The agent-tasks scheduler in Herdr: a sidebar panel with the runner and runs, and a dashboard pane to read a run and retry, run or pause it. |
| [agent-wall](agent-wall/) | One key turns every agent in the current space into a wall of panes, and back. |
| [claude-usage](claude-usage/) | A foldable panel with the usage limits of your Claude accounts, and a red dot when one gets close. |
| [machine-icons](machine-icons/) | Pick the icon each machine shows in the sidebar: an Apple for your Mac, Tux for a WSL box. |
| [reading-width](reading-width/) | An agent alone on screen keeps its text at about 120 columns, centered, instead of spanning the whole window. |
| [smart-split](smart-split/) | One key splits the focused pane along its longer side: right when it's wide, down when it's tall. |

## Installing one

Each folder is laid out like `~/.config/herdr-app`:

1. Copy `<mod>/mods/<mod>/` to `~/.config/herdr-app/mods/`.
2. Merge `<mod>/keys.json` into your `~/.config/herdr-app/keys.json`.
3. Follow any layout change its `RECIPE.md` describes, then run
   `herdr-app check ~/.config/herdr-app/mods/<mod>`.

Or point your agent at the folder: `RECIPE.md` is a brief it can build the mod from.
