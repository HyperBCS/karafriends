import React from "react";
import { Link } from "react-router";
import icon from "../../../../icon.png";

import { FaHistory, FaHome } from "../../icons";
import * as styles from "./NavBar.module.scss";
import { t } from "../../i18n";

const NavBar = () => {
  return (
    <div className={styles.navBar}>
      <Link to="/" aria-label={t("nav.home")}>
        <FaHome />
      </Link>
      <img height={40} src={icon} alt="空" />
      <Link to="/history" aria-label={t("nav.history")}>
        <FaHistory />
      </Link>
    </div>
  );
};

export default NavBar;
