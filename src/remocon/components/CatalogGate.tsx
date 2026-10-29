import React from "react";

import type { LoginService } from "../../common/api";
import useCatalog from "../hooks/useCatalog";
import { t } from "../i18n";
import { sourceName } from "../songLink";
import { EmptyState } from "./ui";

// A DAM or Joysound page, while that catalog is on; in its place, why not
// (a page left open, or opened from an old link, while the karaoke PC has
// no working login for it). Before the first live state, the page.
const CatalogGate = ({
  catalog,
  children,
}: {
  catalog: LoginService;
  children: React.ReactNode;
}) => {
  const view = useCatalog(catalog);
  if (view === null || view === "on") return <>{children}</>;
  return (
    <EmptyState>
      {t(`catalog.${view}`, { source: sourceName(catalog) })}
    </EmptyState>
  );
};

export default CatalogGate;
