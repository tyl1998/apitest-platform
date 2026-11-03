import { useCallback, useEffect, useState } from "react";
import { Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { api, type ExecutionPartitionView, type ArchivedExecutionPartition } from "../api";
import { Empty, Readout } from "../ui";
import { IconButton } from "./IconButton";

/**
 * 执行历史归档（P10-2，计划 14.1；系统管理员）。
 *
 * **名字撞车要先说清**：上面的「执行器」tab 里已经有一张叫「执行分区」的表，那是 P2-8 的
 * 网段标签（`runner_label`，决定一次执行从哪个网段发出）；这里的分区是 `executions` 表按季
 * 切出来的**物理存储分区**。两个词在中文里完全一样，所以在页面上一句话点明区别，不然
 * 一定被当成同一个功能的两个入口。
 *
 * 这个面板存在的理由很具体：归档的形态是「DETACH + 改名保留」，自动维护**永不 DROP**，
 * 于是库里会持续积累已脱离的表。如果「该清哪些」只能靠人记，它就变成无人负责的堆积——
 * 这里把这件事变成看得见的清单，并给清理提供唯一的、会同步删对象的通路。
 */

/** 二进制单位（与 DataSourceDetail 的 formatBytes 同一口径）：分区大小按 KiB/MiB/GiB 读。 */
function formatBytes(value: number) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

/** 只到天：季级的东西精确到秒是噪音（与执行器面板的时长口径同一条取舍）。 */
function formatDay(iso: string) {
  return new Date(iso).toLocaleDateString();
}

/** 脱离至今多久。用天数而不是日期，因为「该清了」的判断依据是它躺了多久。 */
function daysSince(iso: string) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

export function ExecutionArchivePanel() {
  const { t } = useTranslation();
  const [view, setView] = useState<ExecutionPartitionView>();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    try {
      setView(await api.executionPartitions());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  /* 刻意不轮询：这里的数据每 6 小时才可能变一次（维护拍拍频），而分区是季级的。执行器
     面板 10 秒一轮是因为心跳就是 10 秒一次；照搬到这里只会让一个静态页面自己动。 */
  useEffect(() => { void load(); }, [load]);

  /**
   * 清理是**不可逆**的，所以确认框要把两件事说清，缺一不可：
   * ① 数据真的没了（不是归档，是删除）；
   * ② 对象存储里的大响应体会被同步删掉——这正是必须走这里、而不能直接在 psql 里
   *    `DROP TABLE` 的原因（那样会留下永久孤儿对象）。
   */
  function confirmDrop(archive: ArchivedExecutionPartition) {
    Modal.confirm({
      title: t("executionArchive.dropTitle", { name: archive.tableName }),
      content: t("executionArchive.dropHint", { count: archive.rowCount }),
      okText: t("executionArchive.drop"),
      okButtonProps: { danger: true },
      cancelText: t("action.cancel"),
      onOk: async () => {
        setBusy(archive.tableName);
        try {
          const result = await api.dropExecutionPartition(archive.tableName);
          /* 驱动对不上的对象会被跳过（部署换过 fs ↔ s3），跳过了就必须说，否则
             「清理成功」会让人以为存储侧也干净了。 */
          if (result.objectsSkipped) message.warning(t("executionArchive.droppedWithSkipped", { skipped: result.objectsSkipped }));
          else message.success(t("executionArchive.dropped", { count: result.rowCount, objects: result.objectsDeleted }));
          await load();
        } catch { message.error(t("executionArchive.dropFailed")); }
        finally { setBusy(undefined); }
      },
    });
  }

  if (failed) return <Empty title={t("executionArchive.loadFailedTitle")} hint={t("executionArchive.loadFailedHint")} />;
  if (!view) return <p className="muted">{t("common.loading")}</p>;

  const pending = view.archives.filter((each) => each.present);
  const cleared = view.archives.filter((each) => !each.present);

  return <>
    {/* 与「执行器」tab 里那张「执行分区」表的区别，见文件头。 */}
    <p className="form-note">{t("executionArchive.hint")}</p>

    <div className="readouts">
      <Readout label={t("executionArchive.retention")} value={view.retentionMonths > 0 ? view.retentionMonths : t("executionArchive.retentionOff")} unit={view.retentionMonths > 0 ? t("executionArchive.months") : undefined} />
      <Readout label={t("executionArchive.liveCount")} value={view.partitions.length} />
      <Readout label={t("executionArchive.pendingCount")} value={pending.length} />
      <Readout
        label={t("executionArchive.stranded")}
        value={view.strandedRows ?? 0}
        /* 非 0 = 维护拍停过，这批行既不会被归档、又会挡住该季分区创建。用 fail 是因为
           它确实是一个需要处置的坏状态，不是「有点满」的提示。 */
        tone={view.strandedRows ? "fail" : undefined}
      />
      <Readout label={t("executionArchive.storageDriver")} value={view.storageDriver} />
    </div>

    {/* 滞留行只在非 0 时解释：正常恒为 0，为一个不会发生的情况常驻一段说明是噪音。 */}
    {!!view.strandedRows && <p className="form-note">{t("executionArchive.strandedHint")}</p>}

    <h3 className="subhead">{t("executionArchive.liveTitle")}</h3>
    {view.partitions.length ? <div className="table-scroll"><table className="grid">
      <thead><tr>
        <th>{t("executionArchive.partition")}</th>
        <th>{t("executionArchive.range")}</th>
        <th className="col-num">{t("executionArchive.approxRows")}</th>
        <th className="col-num">{t("executionArchive.size")}</th>
      </tr></thead>
      <tbody>{view.partitions.map((partition) => <tr key={partition.name}>
        <td className="mono">
          {partition.name}
          {/* 兜底分区值得显眼：它正常应当是空的，有数据就说明维护拍停过。 */}
          {partition.isDefault && <span className="muted"> · {t("executionArchive.isDefault")}</span>}
        </td>
        {/* 预估行数拿不到时（新分区从未 ANALYZE）显示 `—` 而不是 `0`：`0` 会被读成
            「这张分区是空的，可以删」。兜底分区没有季范围，两个字段都是 null。 */}
        <td className="mono muted">{partition.rangeStart && partition.rangeEnd ? `${formatDay(partition.rangeStart)} – ${formatDay(partition.rangeEnd)}` : "—"}</td>
        <td className="col-num mono">{partition.approxRows === null ? "—" : partition.approxRows}</td>
        <td className="col-num mono">{formatBytes(partition.bytes)}</td>
      </tr>)}</tbody>
    </table></div> : <Empty title={t("executionArchive.liveEmptyTitle")} hint={t("executionArchive.liveEmptyHint")} />}

    <h3 className="subhead" style={{ marginTop: "var(--s5)" }}>{t("executionArchive.archivedTitle")}</h3>
    <p className="form-note">{t("executionArchive.archivedHint")}</p>
    {view.archives.length ? <div className="table-scroll"><table className="grid">
      <thead><tr>
        <th>{t("executionArchive.partition")}</th>
        <th className="col-num">{t("executionArchive.rows")}</th>
        <th>{t("executionArchive.detachedAt")}</th>
        <th className="col-num">{t("executionArchive.size")}</th>
        <th className="col-status">{t("executionArchive.state")}</th>
        <th className="col-actions" />
      </tr></thead>
      <tbody>{view.archives.map((archive) => <tr key={archive.tableName} data-removed={archive.present ? undefined : ""}>
        <td className="mono">
          {archive.tableName}
          {/* 已清除的行这里补一句清除时间。**不回显 droppedBy（用户 id）**：一个裸 uuid
              在页面上没有可读含义，而「谁清的」属于审计流（`execution_partition.drop`
              动作，带表名与行数），不该在这里拿 id 冒充一个名字。 */}
          {archive.droppedAt && <div className="muted">{t("executionArchive.droppedAt", { date: formatDay(archive.droppedAt) })}</div>}
        </td>
        <td className="col-num mono">{archive.rowCount}</td>
        <td className="mono muted">{formatDay(archive.detachedAt)} · {t("executionArchive.daysAgo", { count: daysSince(archive.detachedAt) })}</td>
        <td className="col-num mono">{archive.bytes === null ? "—" : formatBytes(archive.bytes)}</td>
        <td className="col-status">
          {/* 中性 chip，不用语义色：`--pass/--fail/--skip/--busy` 是运行状态的保留词
              （通过/失败/跳过/执行中），拿它们表达「已脱离 / 已清理」是装饰性借用。 */}
          {archive.present ? <span className="chip">{t("executionArchive.stateDetached")}</span> : <span className="chip">{t("executionArchive.stateCleared")}</span>}
        </td>
        <td className="col-actions">
          {archive.present && <div className="row-actions">
            <IconButton icon={<Trash2 size={14} />} label={t("executionArchive.drop")} tone="danger" disabled={busy === archive.tableName} onClick={() => confirmDrop(archive)} />
          </div>}
        </td>
      </tr>)}</tbody>
    </table></div> : <Empty title={t("executionArchive.archivedEmptyTitle")} hint={t("executionArchive.archivedEmptyHint")} />}

    {!!cleared.length && <p className="form-note">{t("executionArchive.clearedNote", { count: cleared.length })}</p>}
  </>;
}
