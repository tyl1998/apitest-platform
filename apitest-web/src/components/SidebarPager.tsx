import { Pagination } from "antd";

/**
 * Paging for the workbench sidebar, shared by 调试记录 and 用例.
 *
 * The sidebar is a narrow column, so this is `simple` mode rather than the
 * page-level pager, whose full control wraps badly under ~320px.
 *
 * The size changer is antd's own, passed explicitly. It must be explicit in
 * both directions: rc-pagination defaults `showSizeChanger` to `total > 50`, so
 * leaving it out means the control silently appears once a list crosses fifty
 * rows — which is how this panel briefly ended up with two of them.
 */
export const SIDEBAR_PAGE_SIZES = [10, 20, 50, 100];

export function SidebarPager({ page, pageSize, total, onPage, onPageSize }: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize: (pageSize: number) => void;
}) {
  /* Below the smallest option every row already fits, so the control would only
     ever be a no-op. Note the threshold is the smallest option and not the
     current size: keying it off the current size would strand the user at 100
     with no way back down. */
  if (total <= SIDEBAR_PAGE_SIZES[0]) return null;

  return <div className="history-pager">
    <Pagination
      size="small"
      simple
      current={page}
      pageSize={pageSize}
      total={total}
      showSizeChanger
      pageSizeOptions={SIDEBAR_PAGE_SIZES}
      onChange={onPage}
      onShowSizeChange={(_page, size) => onPageSize(size)}
    />
  </div>;
}
