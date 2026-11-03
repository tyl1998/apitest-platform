import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * Records the current URL so "restore last page" has something to restore.
 * Only authenticated shells call this; /login must never be recorded, or
 * signing out would trap the next sign-in on the login screen.
 */
export function useRecordLastPage() {
  const location = useLocation();
  useEffect(() => {
    if (location.pathname.startsWith("/login")) return;
    localStorage.setItem("apitest.lastPage", location.pathname + location.search);
  }, [location.pathname, location.search]);
}
