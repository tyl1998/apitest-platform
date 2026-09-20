import { useCallback, useEffect, useState } from "react";
import { Drawer, Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import { api, type AssetVersion, type AssetVersionType, type FieldDiff, type SnapshotDiff } from "../api";
import { Empty } from "../ui";
import { useCanWrite } from "../hooks/useMyRole";
import { apiMessage } from "./DataSourceList";

/*
 * P10-5：资产版本历史抽屉——版本列表 + 改动内容 diff + 回滚。靠 `assetType` 分派到统一的
 * 后端读侧路由。P10-6 扩面到 11 类资产（接口 / 接口用例 / 文本用例 / 环境 / Mock / 脚本 /
 * 流程 / 套件 / 数据源 / SQL 定义 / 仓库任务），并取代了原来各资源详情里的「变更历史」抽屉。
 *
 * 「谁在何时动过它」交给项目级审计页；本抽屉回答 ★硬验收项「改成了什么」——选中两版看服务端
 * 算好的逐行 diff。环境 secret / 数据源密文只显示键名增删，永不回显值（Spec 4.6）。
 *
 * 交互：列表默认选中「最新 + 次新」两版并展示 diff；点某一版切换选择（保留较新的一个当
 * 「新」侧、被点的当「旧」侧，即「和这一版比现在改了什么」）。回滚在写权限下每版一个按钮，
 * 走二次确认（不可逆动作语义），确认后把该版写回 → 产一个新版本，刷新列表。
 */

export function VersionHistoryDrawer({ projectId, assetType, assetId, name, open, onClose, onRolledBack }: {
  projectId: string;
  assetType: AssetVersionType;
  assetId: string;
  /** 资源名（标题用）。 */
  name?: string;
  open: boolean;
  onClose: () => void;
  /** 回滚成功后回调（宿主重拉资源、抽屉表单）。 */
  onRolledBack?: () => void;
}) {
  const { t } = useTranslation();
  const canWrite = useCanWrite();
  const [versions, setVersions] = useState<AssetVersion[]>([]);
  const [loading, setLoading] = useState(false);
  /* 选中两版做 diff：`[旧, 新]`。默认取最新两版。 */
  const [selected, setSelected] = useState<[number, number] | null>(null);
  const [diff, setDiff] = useState<SnapshotDiff | null>(null);
  const [diffPair, setDiffPair] = useState<{ from: number | null; to: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.assetVersions(projectId, assetType, assetId);
      setVersions(rows);
      /* 默认选最新两版（版本列表已倒序）；只有一版时选它自己与「空」比。 */
      if (rows.length >= 2) setSelected([rows[1].versionNo, rows[0].versionNo]);
      else if (rows.length === 1) setSelected([rows[0].versionNo, rows[0].versionNo]);
      else setSelected(null);
    } catch {
      message.error(t("version.loadFailed"));
    } finally { setLoading(false); }
  }, [projectId, assetType, assetId, t]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  /* 选中变化时拉 diff。旧==新（只有一版）时走「相邻/最新」接口，让服务端把首版与空比。 */
  useEffect(() => {
    if (!open || !selected) { setDiff(null); setDiffPair(null); return; }
    let aborted = false;
    const [older, newer] = selected;
    const request = older === newer
      ? api.assetVersionLatestDiff(projectId, assetType, assetId)
      : api.assetVersionDiff(projectId, assetType, assetId, older, newer);
    request
      .then((result) => { if (!aborted) { setDiff(result.diff); setDiffPair({ from: result.from, to: result.to }); } })
      .catch(() => { if (!aborted) message.error(t("version.loadFailed")); });
    return () => { aborted = true; };
  }, [open, selected, projectId, assetType, assetId, t]);

  /* 点某一版：把它当「旧」侧，当前列表最新版当「新」侧——即「相对这一版，现在改了什么」。
     点最新版本身则退回「最新 vs 次新」。 */
  function pick(versionNo: number) {
    const newest = versions[0]?.versionNo;
    if (newest === undefined) return;
    if (versionNo === newest) {
      const second = versions[1]?.versionNo ?? newest;
      setSelected([second, newest]);
    } else {
      setSelected([versionNo, newest]);
    }
  }

  function rollback(versionNo: number) {
    Modal.confirm({
      title: t("version.rollbackTitle", { no: versionNo }),
      content: <>
        <p>{t("version.rollbackHint", { no: versionNo })}</p>
        {assetType === "environment" && <p className="form-note">{t("version.rollbackSecrets")}</p>}
      </>,
      okText: t("version.rollbackOk"),
      cancelText: t("action.cancel"),
      onOk: async () => {
        try {
          await api.rollbackAssetVersion(projectId, assetType, assetId, versionNo);
          message.success(t("version.rollbackDone", { no: versionNo }));
          await load();
          onRolledBack?.();
        } catch (error) {
          message.error(apiMessage(error) ?? t("version.rollbackFailed"));
        }
      },
    });
  }

  const older = selected?.[0];
  const newer = selected?.[1];

  return <Drawer
    title={name ? t("version.historyTitle", { name }) : t("version.history")}
    open={open}
    onClose={onClose}
    width={820}
  >
    <p className="form-note">{t("version.historyHint")}</p>
    {versions.length ? <>
      <div className="version-list">
        {versions.map((version, index) => {
          const isNewer = version.versionNo === newer;
          const isOlder = version.versionNo === older && older !== newer;
          return <div
            key={version.id}
            className={`version-row${isNewer || isOlder ? " is-selected" : ""}`}
            data-clickable
            onClick={() => pick(version.versionNo)}
          >
            {/* 选中角标：1 = 旧（左），2 = 新（右）。未选中占位空。 */}
            <span>{isOlder ? <span className="version-pick">1</span> : isNewer ? <span className="version-pick">2</span> : <span style={{ display: "inline-block", width: 20 }} />}</span>
            <span>
              <span className="version-no mono">{t("version.versionNo", { no: version.versionNo })}</span>
              {index === 0 && <span className="resource-type mono">{t("version.current")}</span>}
              <span className="mono muted"> · {version.changeSummary}</span>
              <div className="version-meta mono">
                {version.createdByEmail ?? t("audit.nonUser")} · {new Date(version.createdAt).toLocaleString()}
              </div>
            </span>
            {/* 回滚：最新版不给按钮（回滚到当前无意义）；写权限才渲染。 */}
            <span onClick={(event) => event.stopPropagation()}>
              {canWrite && index !== 0 && <button className="btn btn-small" onClick={() => rollback(version.versionNo)}>{t("version.rollback")}</button>}
            </span>
          </div>;
        })}
      </div>

      <div style={{ marginTop: 16 }}>
        {diff && diffPair ? <>
          <h4 className="mono" style={{ margin: "0 0 8px" }}>
            {diffPair.from === null
              ? t("version.diffAgainstEmpty", { to: diffPair.to })
              : t("version.diffTitle", { from: diffPair.from, to: diffPair.to })}
          </h4>
          {diff.identical
            ? <Empty title={t("version.identical")} hint={t("version.compareHint")} />
            : diff.fields.map((field) => <DiffField key={field.field} field={field} />)}
        </> : !loading && <Empty title={t("version.selectTwo")} hint={t("version.compareHint")} />}
      </div>
    </> : !loading && <Empty title={t("version.emptyTitle")} hint={t("version.emptyHint")} />}
  </Drawer>;
}

/** 一个字段的 diff：字段名 + 增/删/改角标 + 逐行着色。secretKeys 字段附一句 secret 说明。 */
function DiffField({ field }: { field: FieldDiff }) {
  const { t } = useTranslation();
  return <div className="version-diff-field">
    <div className="diff-field-head">
      <span className="diff-field-name">{field.field}</span>
      <span className={`diff-badge ${field.kind}`}>{t(`version.${field.kind}`)}</span>
      {field.field === "secretKeys" && <span className="muted" style={{ fontSize: 11 }}>{t("version.secretNote")}</span>}
    </div>
    <div className="diff-lines">
      {field.lines.map((line, index) => <div key={index} className={`diff-line ${line.kind}`}>
        <span className="diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}</span>
        <span>{line.text}</span>
      </div>)}
    </div>
  </div>;
}
