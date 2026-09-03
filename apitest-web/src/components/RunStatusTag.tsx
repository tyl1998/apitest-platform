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
    /* 勾选执行的第四态（P4.5-9）：键早就有了（接口列表用它当「从没跑过」的纯文本），
       这里第一次让它进状态词表。 */
    not_run: t("status.notRun"),
  };
  return <Status status={status} label={label[status]} />;
}
