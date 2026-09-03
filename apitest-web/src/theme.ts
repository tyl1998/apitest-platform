import { useEffect, useLayoutEffect, useState } from "react";
import { theme as antdAlgorithms, type ThemeConfig } from "antd";

export type Mode = "light" | "dark";
export type ModePreference = Mode | "system";

const KEY = "apitest.theme";

/**
 * The palette lives here, not in CSS.
 *
 * An earlier version declared colours in CSS and read them back with
 * getComputedStyle to build the antd theme. That desynchronised: the read
 * happened during render, before the new data-theme attribute was
 * committed, so antd always trailed the shell by one toggle. Declaring the
 * values in TS and projecting them into CSS keeps both consumers exact.
 */
const PALETTE = {
  light: {
    bg: "#f7f7f6",
    surface: "#ffffff",
    raised: "#fbfbfa",
    /* Hover fill for nav items on --surface. --raised is only a shade away
       from white, which made the sidebar's hover state invisible; this is the
       same warm grey family, one step further down. */
    hover: "#f0f0ee",
    line: "#e3e3e0",
    lineStrong: "#cfcfca",
    ink: "#1c1c1a",
    ink2: "#5c5c57",
    /* Dark enough for AA on both --surface and --raised: secondary text
       here carries request paths and column headers, which get read. */
    ink3: "#72726b",
    accent: "#3a5f8a",
    accentInk: "#ffffff",
    accentSoft: "#eef2f7",
    selected: "#f0f3f7",
    pass: "#1a7f4b",
    fail: "#c2321f",
    skip: "#8a6d1f",
    busy: "#1f5fa8",
    passBg: "#eaf4ee",
    failBg: "#fbecea",
    skipBg: "#f8f2e2",
    busyBg: "#eaf0f8",
    overlay: "rgba(28, 28, 26, .34)",
  },
  dark: {
    bg: "#16181d",
    surface: "#1c1f25",
    raised: "#21252c",
    hover: "#262b33",
    line: "#2c313a",
    lineStrong: "#3a404b",
    ink: "#e4e6e9",
    ink2: "#b0b6c0",
    ink3: "#8b929d",
    accent: "#7aa2d4",
    accentInk: "#10131a",
    accentSoft: "#232a34",
    selected: "#232833",
    /* Lifted for legibility on dark surfaces; intent is unchanged. */
    pass: "#4fb07a",
    fail: "#e2705d",
    skip: "#cfa94a",
    busy: "#6f9ed6",
    passBg: "#1b2822",
    failBg: "#2c1f1d",
    skipBg: "#2a2519",
    busyBg: "#1e2733",
    overlay: "rgba(0, 0, 0, .58)",
  },
} as const;

const UI_FONT = '"Inter", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';

/* CSS custom property name for each palette key. */
const CSS_VAR: Record<keyof typeof PALETTE.light, string> = {
  bg: "--bg",
  surface: "--surface",
  raised: "--raised",
  hover: "--hover",
  line: "--line",
  lineStrong: "--line-strong",
  ink: "--ink",
  ink2: "--ink-2",
  ink3: "--ink-3",
  accent: "--accent",
  accentInk: "--accent-ink",
  accentSoft: "--accent-soft",
  selected: "--selected",
  pass: "--pass",
  fail: "--fail",
  skip: "--skip",
  busy: "--busy",
  passBg: "--pass-bg",
  failBg: "--fail-bg",
  skipBg: "--skip-bg",
  busyBg: "--busy-bg",
  overlay: "--overlay",
};

export function readMode(): Mode {
  const saved = localStorage.getItem(KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function readModePreference(): ModePreference {
  const saved = localStorage.getItem(KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

/**
 * Writes the palette onto <html> as custom properties, so antd's portalled
 * layers (Modal, Drawer, Select dropdown) inherit them too.
 */
function applyMode(mode: Mode) {
  const root = document.documentElement;
  const palette = PALETTE[mode];
  for (const key of Object.keys(CSS_VAR) as (keyof typeof CSS_VAR)[]) {
    root.style.setProperty(CSS_VAR[key], palette[key]);
  }
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
}

/* Paint the initial mode before React mounts, to avoid a flash. */
applyMode(readMode());

/**
 * Call this in exactly one component. Two callers means two independent
 * states, and the shell will disagree with antd's portals.
 */
export function useMode() {
  const [mode, setMode] = useState<Mode>(readMode);
  const [preference, setPreferenceState] = useState<ModePreference>(readModePreference);

  useLayoutEffect(() => {
    applyMode(mode);
    if (preference === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, preference);
  }, [mode, preference]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = (event: MediaQueryListEvent) => {
      if (preference === "system") setMode(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [preference]);

  const setPreference = (value: ModePreference) => {
    setPreferenceState(value);
    setMode(value === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : value);
  };
  return { mode, preference, setPreference, toggle: () => setPreference(mode === "light" ? "dark" : "light") };
}

/**
 * Read-only view of the active mode, for a third-party widget that needs its own
 * light/dark flag (Monaco is the only one today).
 *
 * Deliberately **not** `useMode()`: that hook owns the mode and must stay
 * single-caller, or the shell and antd's portals end up with two disagreeing
 * states. This one holds no state of its own — it observes the `data-theme`
 * attribute `applyMode()` already writes, so it cannot drift from the shell and
 * cannot be the thing that sets the mode.
 */
export function useThemeMode(): Mode {
  const [mode, setMode] = useState<Mode>(() => (document.documentElement.dataset.theme as Mode) ?? readMode());

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const next = document.documentElement.dataset.theme as Mode | undefined;
      if (next === "light" || next === "dark") setMode(next);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return mode;
}

/**
 * Bridges the palette into antd for the components kept for behaviour
 * (Modal, Drawer, Form, Select).
 *
 * The algorithm switch is required: antd v5 derives container surfaces from
 * it, so handing dark colours to the default algorithm still yields white
 * Drawers and Selects.
 */
export function antdTheme(mode: Mode): ThemeConfig {
  const c = PALETTE[mode];

  return {
    algorithm: mode === "dark" ? antdAlgorithms.darkAlgorithm : antdAlgorithms.defaultAlgorithm,
    token: {
      colorPrimary: c.accent,
      colorSuccess: c.pass,
      colorError: c.fail,
      colorWarning: c.skip,
      colorInfo: c.busy,

      /* Set explicitly rather than derived, so antd's surfaces match ours
         exactly instead of landing a shade away. */
      colorBgBase: c.surface,
      colorBgContainer: c.surface,
      colorBgElevated: c.surface,
      colorBgLayout: c.bg,
      colorBgMask: c.overlay,

      colorBorder: c.lineStrong,
      colorBorderSecondary: c.line,
      colorText: c.ink,
      colorTextSecondary: c.ink2,
      colorTextTertiary: c.ink3,
      colorTextPlaceholder: c.ink3,

      borderRadius: 5,
      fontFamily: UI_FONT,
      fontSize: 13,
      controlHeight: 34,
      motionDurationMid: "0.12s",
      wireframe: false,
    },
    components: {
      Modal: { titleFontSize: 15, borderRadiusLG: 6, contentBg: c.surface, headerBg: c.surface },
      Drawer: { paddingLG: 20, colorBgElevated: c.surface },
      Select: { optionSelectedBg: c.selected },
      Form: { labelColor: c.ink2, verticalLabelPadding: "0 0 5px" },
    },
  };
}
