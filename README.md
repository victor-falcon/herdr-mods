# herdr-mods

Mods for the [Herdr](https://herdr.dev) app.

| Mod | What it does |
|-----|--------------|
| [agent-wall](agent-wall/) | One key turns every agent in the current space into a wall of panes, and back. |

## Installing one

Each folder is laid out like `~/.config/herdr-app`:

1. Copy `<mod>/mods/<mod>/` to `~/.config/herdr-app/mods/`.
2. Merge `<mod>/keys.json` into your `~/.config/herdr-app/keys.json`.
3. Follow any layout change its `RECIPE.md` describes, then run
   `herdr-app check ~/.config/herdr-app/mods/<mod>`.

Or point your agent at the folder: `RECIPE.md` is a brief it can build the mod from.
