import React from "react";
import { FaHistory, FaHome } from "react-icons/fa";
import { Link } from "react-router";
import icon from "url:../../images/icon.png";

import * as styles from "./NavBar.module.scss";

const NavBar = () => {
  return (
    <div className={styles.navBar}>
      <Link to="/" aria-label="Home">
        <FaHome />
      </Link>
      <img height={40} src={icon} alt="空" />
      <Link to="/history" aria-label="History">
        <FaHistory />
      </Link>
    </div>
  );
};

export default NavBar;
