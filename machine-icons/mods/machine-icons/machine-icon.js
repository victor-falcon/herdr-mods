// Which icon to draw for a machine: the one picked in the machine-icons mod,
// else `fallback`. Herdr won't import across mods, so a mod that shows
// machines keeps a verbatim copy of this file next to its main.js.
//
//   import { machineIcon } from "./machine-icon.js";
//   svg(machineIcon(space.machine, "mods/workspace-chrome/monitor.svg"))

import { shared } from "herdr";

// shared("machine-icons"): { [machine name, "" for this computer]: icon name }.
export const MACHINE_ICONS_KEY = "machine-icons";

export function machineIcon(machine, fallback) {
  const icon = (shared(MACHINE_ICONS_KEY) ?? {})[machine ?? ""];
  return icon ? `mods/machine-icons/icons/${icon}.svg` : fallback;
}
