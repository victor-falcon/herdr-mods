// Claude subscription usage for one or more accounts, as a foldable panel.
// Each account's own `claude` CLI answers its `get_usage` control request
// (claude-usage.sh), so nothing here reads a token. Folded, the header shows a
// red dot when any limit is at the warning level.
//
// Self-contained so another mod can carry a copy of this file and draw the same
// panel inside its own layout (Herdr won't import across mod folders).
// Adapted from nozikov/herdr-usage-limits (MIT).

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, appHome, shared, setShared } from "herdr";

// account id -> { windows: [{ id, kind, scope, percent, resetsAt, durationSec }], plan, at, error }
const STATE_KEY = "claude-usage.state";
const FOLDED_KEY = "claude-usage.folded";
const FETCHED_KEY = "claude-usage.fetchedAt"; // ms; every copy shares one fetch
const REFRESH_MS = 5 * 60000;
const STALE_S = 15 * 60;
const HOT = 90;
const HOUR = 3600;
const WEEK = 7 * 24 * HOUR;

const STRINGS = {
  en: {
    title: "Usage", session: "Session", week: "Week", resetsIn: "Resets in", updated: "Updated", loading: "Loading…",
    now: "just now", min: (n) => `${n} min ago`, hours: (n) => `${n} h ago`,
    noReply: "The claude CLI didn't answer", noCli: "claude CLI not found", noLimits: "No limits: signed in with a subscription?",
    failed: "Couldn't read usage",
  },
  es: {
    title: "Usage", session: "Sesión", week: "Semana", resetsIn: "Se reinicia en", updated: "Actualizado", loading: "Cargando…",
    now: "ahora mismo", min: (n) => `hace ${n} min`, hours: (n) => `hace ${n} h`,
    noReply: "El CLI de claude no respondió", noCli: "No encuentro el CLI de claude", noLimits: "Sin límites: ¿sesión iniciada con la suscripción?",
    failed: "No se pudo leer el uso",
  },
};

// The options a layout's props give, with defaults:
// { accounts: [{ name, config }], warn: 75, lang: "en" }. `config` is the
// account's CLAUDE_CONFIG_DIR ("~/..." allowed); left out, the default ~/.claude.
export function usageOptions(p, dir) {
  const accounts = (Array.isArray(p?.accounts) && p.accounts.length ? p.accounts : [{ name: "Claude" }])
    .map((a, i) => ({ id: String(a.id ?? a.name ?? i), name: String(a.name ?? "Claude"), config: a.config ?? null }));
  return { accounts, warn: Number(p?.warn) || 75, s: STRINGS[p?.lang] ?? STRINGS.en, dir };
}

const configArg = (c) => (!c ? "-" : c.startsWith("~/") ? `${home()}${c.slice(1)}` : c);

const toEpoch = (v) => {
  const ms = v == null ? NaN : Date.parse(v);
  return Number.isNaN(ms) ? null : Math.round(ms / 60000) * 60; // to the minute: resets land at :59.6
};

function windowOf(l) {
  const base = { kind: l.kind, percent: Math.round(Number(l.percent)), resetsAt: toEpoch(l.resets_at) };
  if (l.kind === "session") return { ...base, id: "session", durationSec: 5 * HOUR };
  if (l.kind === "weekly_all") return { ...base, id: "weekly", durationSec: WEEK };
  const scope = l.scope?.model?.display_name || l.scope?.surface || String(l.kind ?? "limit").replace(/_/g, " ");
  return { ...base, id: `${l.kind}:${scope}`, scope, durationSec: l.kind === "weekly_scoped" ? WEEK : null };
}

// The CLI's reply -> { windows, plan } or { error }.
export function parseUsage(text, s = STRINGS.en) {
  const msg = String(text ?? "").split("\n").map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .find((m) => m?.type === "control_response");
  if (!msg) return { error: s.noReply };
  if (msg.response?.subtype !== "success") return { error: String(msg.response?.error ?? s.failed) };
  const body = msg.response.response ?? {};
  const rl = body.rate_limits;
  if (!rl) return { error: s.noLimits };
  const windows = Array.isArray(rl.limits)
    ? rl.limits.filter((l) => l?.percent != null).map(windowOf)
    : [
        rl.five_hour?.utilization != null && windowOf({ kind: "session", percent: rl.five_hour.utilization, resets_at: rl.five_hour.resets_at }),
        rl.seven_day?.utilization != null && windowOf({ kind: "weekly_all", percent: rl.seven_day.utilization, resets_at: rl.seven_day.resets_at }),
      ].filter(Boolean);
  if (!windows.length) return { error: s.noLimits };
  return { windows, plan: body.subscription_type ?? null };
}

// One account after the other, so two CLIs never start at once. A failure keeps
// the last good reading and says why.
async function fetchAll(o) {
  setShared(FETCHED_KEY, Date.now());
  const helper = `${appHome()}/${o.dir}/claude-usage.sh`;
  for (const a of o.accounts) {
    let next;
    try {
      const r = await exec("sh", [helper, configArg(a.config)]);
      next = r.code === 127 ? { error: o.s.noCli } : parseUsage(r.stdout, o.s);
    } catch (e) {
      next = { error: String(e?.message ?? e) };
    }
    const prev = shared(STATE_KEY)?.[a.id];
    const value = next.error ? { ...(prev ?? {}), error: next.error } : { ...next, at: Math.floor(Date.now() / 1000), error: null };
    setShared(STATE_KEY, { ...(shared(STATE_KEY) ?? {}), [a.id]: value });
  }
}

// Fetch now (unless another copy just did) and every few minutes; redraw every
// minute so the countdowns move. `options()` is read each time: props can change.
export function startUsage(cx, options) {
  let busy = false;
  const tick = (cx) => {
    // An account with no reading yet (just added) doesn't wait for the next round.
    const unread = options().accounts.some((a) => !shared(STATE_KEY)?.[a.id]);
    if (busy || (!unread && Date.now() - (Number(shared(FETCHED_KEY)) || 0) < REFRESH_MS - 30000)) return;
    busy = true;
    cx.spawn(async () => { try { await fetchAll(options()); } finally { busy = false; } });
  };
  tick(cx);
  cx.timer.every(60000, (cx) => { tick(cx); cx.notify(); });
}

const live = (w, now) => w.resetsAt == null || w.resetsAt > now;

function timeLeft(sec) {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return "<1m";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function ago(at, now, s) {
  const sec = Math.max(0, now - at);
  if (sec < 90) return s.now;
  if (sec < 3600) return s.min(Math.round(sec / 60));
  return s.hours(Math.round(sec / 3600));
}

const label = (w, s) => (w.kind === "session" ? s.session : w.kind === "weekly_all" ? s.week : w.scope ?? w.id);

const color = (t, p, warn) => (p >= HOT ? t.ansi1 : p >= warn ? t.ansi3 : t.ansi2);

const folded = () => shared(FOLDED_KEY) === true;

// Any limit of any account at the warning level or above.
export function nearLimit(o, now = Math.floor(Date.now() / 1000)) {
  const st = shared(STATE_KEY) ?? {};
  return o.accounts.some((a) => (st[a.id]?.windows ?? []).some((w) => live(w, now) && w.percent >= o.warn));
}

// Rows and sizes below are fixed, so a block can be sized to the panel exactly.
const HEADER = 26, ACCOUNT = 22, LIMIT = 20, PAD_TOP = 6, PAD_BOTTOM = 4, GAP = 6;

export function panelHeight(o) {
  if (folded()) return PAD_TOP + HEADER;
  const st = shared(STATE_KEY) ?? {};
  const body = o.accounts.reduce((h, a) => h + ACCOUNT + (st[a.id]?.windows?.length ?? 0) * (LIMIT + 1), 0) + GAP * (o.accounts.length - 1);
  return PAD_TOP + HEADER + 1 + body + PAD_BOTTOM;
}

function bar(t, w, now, warn) {
  const elapsed = w.resetsAt != null && w.durationSec ? Math.min(1, Math.max(0, 1 - (w.resetsAt - now) / w.durationSec)) : null;
  return div().flex_1().min_w(0).h(4).rounded(2).bg(t.border).relative()
    .child(div().absolute().left(0).top(0).h(4).rounded(2).w(`${Math.min(100, Math.max(0, w.percent))}%`).bg(color(t, w.percent, warn)))
    // The tick: how much of the window's time has passed.
    .when(elapsed != null, (el) => el.child(div().absolute().top(-2).h(8).w(1).left(`${Math.round(elapsed * 100)}%`).bg(t.foreground).opacity(0.75)));
}

function limitRow(t, o, a, w, now, dim) {
  const ok = live(w, now);
  return h_flex().id(`claude-usage-${a.id}-${w.id}`).h(LIMIT).px(10).gap(8).items_center().text_size(11).when(dim, (el) => el.opacity(0.55))
    .when(ok && w.resetsAt != null, (el) => el.tooltip(`${o.s.resetsIn} ${timeLeft(w.resetsAt - now)}`))
    .child(div().w(44).flex_none().truncate().text_color(t.dim).child(label(w, o.s)))
    .child(ok ? bar(t, w, now, o.warn) : div().flex_1().h(4).rounded(2).bg(t.border))
    .child(div().w(30).flex_none().flex().justify_end().text_color(ok ? color(t, w.percent, o.warn) : t.dim).child(ok ? `${w.percent}%` : "—"))
    .child(div().w(46).flex_none().flex().justify_end().text_size(10.5).text_color(t.dim)
      .child(ok && w.resetsAt != null ? timeLeft(w.resetsAt - now) : ""));
}

function account(t, o, a, st, now) {
  const dim = Boolean(st?.error) || (st?.at != null && now - st.at > STALE_S);
  const status = st?.error ? st.error : st?.at != null ? `${o.s.updated} ${ago(st.at, now, o.s)}` : o.s.loading;
  return v_flex().gap(1)
    .child(h_flex().id(`claude-usage-${a.id}`).h(ACCOUNT).px(10).gap(6).items_center().tooltip(status)
      .child(div().text_size(12).text_color(t.foreground).child(a.name))
      .when(Boolean(st?.plan), (el) => el.child(div().px(5).rounded(4).bg(t.hover).text_size(10).text_color(t.dim)
        .child(st.plan.charAt(0).toUpperCase() + st.plan.slice(1))))
      .child(div().flex_1())
      .when(Boolean(st?.error), (el) => el.child(div().text_size(11).font_bold().text_color(t.dim).child("!")))
      .when(!st, (el) => el.child(div().text_size(11).text_color(t.dim).child("…"))))
    .children((st?.windows ?? []).map((w) => limitRow(t, o, a, w, now, dim)));
}

// The panel: a header that folds it, then each account's limits.
export function usagePanel(t, o) {
  const now = Math.floor(Date.now() / 1000);
  const isFolded = folded();
  const st = shared(STATE_KEY) ?? {};
  return v_flex().flex_none().px(8).pt(PAD_TOP).gap(1)
    .child(h_flex().id("claude-usage-toggle").h(HEADER).px(10).gap(8).items_center().rounded(8).cursor_pointer().text_size(11.5).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => setShared(FOLDED_KEY, !isFolded))
      .child(div().flex_1().min_w(0).truncate().child(o.s.title))
      // The same dot an agent list uses for an agent that needs you, in red.
      .when(isFolded && nearLimit(o, now), (el) => el.child(div().size(7).mx(3).flex_none().rounded(4).bg(t.ansi1)))
      .child(svg(`${o.dir}/chevron-${isFolded ? "right" : "down"}.svg`).size(11).flex_none()))
    .when(!isFolded, (el) => el.child(v_flex().gap(GAP).pb(PAD_BOTTOM).children(o.accounts.map((a) => account(t, o, a, st[a.id], now)))));
}
