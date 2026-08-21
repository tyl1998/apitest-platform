import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import { IconButton } from "./IconButton";

/**
 * Copies a block of machine data — a response body, a header map, a request
 * snapshot.
 *
 * Feedback is the icon itself rather than a toast: copying is incidental to
 * whatever the user is actually doing, and a toast per copy would interrupt a
 * loop people run dozens of times an hour.
 */
export function CopyButton({ value, label }: {
  /**
   * Resolved on click, not passed as a string, so a large body is only
   * serialised when someone actually copies it. Callers hand over exactly the
   * text they render, which keeps the clipboard matching the panel — the
   * response body has a pretty/raw toggle, and copying the other form would be
   * silently wrong.
   */
  value: () => string;
  label?: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  /* The button can unmount while the confirmation is still showing — switching
     response tabs mid-copy is normal — and the timer would then set state on a
     dead component. */
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    const text = value();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /**
       * `navigator.clipboard` only exists in a secure context. This app is
       * reached over plain http on LAN addresses, where it is absent entirely,
       * so the textarea path is load-bearing rather than legacy support.
       */
      const scratch = document.createElement("textarea");
      scratch.value = text;
      /* Off-screen rather than hidden: `display:none` cannot be selected. */
      scratch.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(scratch);
      scratch.select();
      try { document.execCommand("copy"); } finally { scratch.remove(); }
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1400);
  }

  return <IconButton
    icon={copied ? <Check size={13} /> : <Copy size={13} />}
    label={copied ? t("action.copied") : label ?? t("action.copy")}
    onClick={() => void copy()}
  />;
}
