import { useTranslation } from "react-i18next";
import { Status, type RunStatus } from "../ui";

/** Wraps the design-system Status so run states follow the selected language. */
export function RunStatusTag({ status }: { status: RunStatus }) {
  const { t } = useTranslation();
  const label: Record<RunStatus, string> = {
    pass: t("status.pass"),
    fail: t("status.fail"),
    skip: t("status.skip"),
    running: t("status.running"),
    queued: t("status.queued"),
    canceled: t("status.canceled"),
  };
  return <Status status={status} label={label[status]} />;
}
