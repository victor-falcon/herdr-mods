// Machine icons: pick the icon each machine shows in the sidebar (an Apple
// for this Mac, Tux for a WSL box, ...). Opened as a dialog
// (`mod.open:machine-icons`); props { machine } shows only that machine
// ("" or null for this computer). The choice is kept in
// shared("machine-icons"); mods that show machines read it with
// machine-icon.js.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { machines, shared, setShared, theme, props, closeOverlay } from "herdr";
import { MACHINE_ICONS_KEY } from "./machine-icon.js";

const ICONS = [
  ["apple", "Apple"], ["laptop", "Laptop"], ["monitor", "Desktop"],
  ["linux", "Linux"], ["ubuntu", "Ubuntu"], ["debian", "Debian"], ["archlinux", "Arch"], ["fedora", "Fedora"], ["raspberrypi", "Raspberry Pi"],
  ["windows", "Windows"], ["server", "Server"], ["cloud", "Cloud"], ["container", "Container"], ["terminal", "Terminal"], ["house", "Home"],
];
const path = (icon) => `mods/machine-icons/icons/${icon}.svg`;

export default class MachineIcons extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  pick(key, icon) {
    const all = { ...(shared(MACHINE_ICONS_KEY) ?? {}) };
    if (icon) all[key] = icon;
    else delete all[key];
    setShared(MACHINE_ICONS_KEY, all);
  }

  machine(m, chosen, t) {
    const key = m.name ?? "";
    const current = chosen[key] ?? null;
    const choice = (icon, label) => {
      const on = current === icon;
      return div().id(`icon-${key}-${icon}`).size(32).flex_none().rounded(8).flex().items_center().justify_center().cursor_pointer()
        .border_1().border_color(on ? t.accent : "#00000000")
        .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .text_color(on ? t.foreground : t.muted)
        .tooltip(label)
        .on_click(() => this.pick(key, on ? null : icon))
        .child(svg(path(icon)).size(16));
    };
    return v_flex().gap(8)
      .child(h_flex().gap(8).items_center().text_size(13)
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(m.name ?? "This computer"))
        .when(Boolean(current), (el) => el.child(
          div().id(`reset-${key}`).px(8).h(22).rounded(6).flex().items_center().text_size(11.5).text_color(t.dim).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => this.pick(key, null))
            .child("Default"))))
      .child(h_flex().flex_wrap().gap(4).children(ICONS.map(([icon, label]) => choice(icon, label))));
  }

  render(_cx) {
    const t = theme();
    const only = props()?.machine;
    const chosen = shared(MACHINE_ICONS_KEY) ?? {};
    const list = machines().filter((m) => only === undefined || (m.name ?? "") === (only ?? ""));
    return v_flex().id("machine-icons").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        closeOverlay(props().overlay);
        cx.stop_propagation();
      })
      .w_full().p(18).gap(16).rounded(8).bg(t.popover)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Machine icons"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(v_flex().id("machine-list").max_h(520).gap(18).overflow_y_scrollbar()
        .children(list.length ? list.map((m) => this.machine(m, chosen, t)) : [div().text_size(13).text_color(t.dim).child("No such machine.")]));
  }
}
