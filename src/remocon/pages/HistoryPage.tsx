import React from "react";

import SongHistory from "../components/SongHistory";
import { t } from "../i18n";

const HistoryPage = () => (
  <>
    <h2>{t("history.heading")}</h2>
    <SongHistory />
  </>
);

export default HistoryPage;
