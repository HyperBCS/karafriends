import type { CatalogStatus, LoginService } from "../../common/api";
import { useLiveState } from "../../common/apiClient";

// How a catalog looks from a phone: on; signing in; can't be reached right
// now; or not available (turned off by the host, no login, or one the
// service refused). Null before the first live state, when the phone can't
// tell yet.
export type CatalogView = "on" | "checking" | "unreachable" | "off";

export function catalogView(
  status: CatalogStatus | undefined,
): CatalogView | null {
  if (!status) return null;
  return status.state === "failed" || status.state === "disabled"
    ? "off"
    : status.state;
}

// DAM's or Joysound's, from the live state.
export default function useCatalog(catalog: LoginService): CatalogView | null {
  return useLiveState((state) => catalogView(state?.catalogs[catalog]));
}
